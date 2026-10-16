import json
import logging
from typing import Any

from langgraph.graph import END, StateGraph

from graph.nodes.human_input import human_input
from graph.nodes.llm_node import make_llm_node
from graph.nodes.memory import memory
from graph.nodes.reflection_node import make_reflection_node
from graph.nodes.retrieval import retrieval
from graph.nodes.tool_executor import tool_executor
from graph.nodes.web_search import web_search
from graph.state import RetrievalState

logger = logging.getLogger(__name__)

# customer_id -> (graph_identity, compiled_graph, max_iterations). The identity
# is (graphId, latestVersion): a mismatch means the customer's resolved graph
# changed (edit, fork, or a new System publish) and forces a rebuild.
_graph_cache: dict[str, tuple[tuple, Any, int]] = {}

# Same shape/keying as _graph_cache but holds the checkpointer-bound (durable)
# compilation used by the /runs path — kept separate so durable and stateless
# graphs for the same customer coexist instead of evicting each other.
_durable_graph_cache: dict[str, tuple[tuple, Any, int]] = {}

# safety cap on how many times the graph can loop through a cycle before LangGraph forcibly aborts the run
_DEFAULT_MAX_ITERATIONS = 10


def _make_condition_router(condition: dict, routes: dict[str, str]):
    """
    Return a routing function for a conditional edge.

    condition fields:
      condition_key   (str)  — state field to evaluate; first-class state
                               fields are checked first, then the free-form
                               scratch channel (custom node output_keys)
      condition_type  (str)  — "bool" (default) | "list_empty" | "value" | "tool_route"
        "bool"       : routes["true"] when the field is truthy, else routes["false"]
        "list_empty" : routes["true"] when the field is an empty list or None
        "value"      : the field's value (as a string) is matched against the
                       route labels; "__default__" is the fallback route
        "tool_route" : inspects state["tool_calls"] — routes["builtin"] when any
                       call names a tool enabled for THIS request
                       (state["builtin_tools"]), routes["caller"] when only
                       caller-defined calls exist, routes["none"] when there
                       are no calls (condition_key is ignored)
    """
    ctype = condition.get("condition_type", "bool")
    # tool_route ignores condition_key, so don't require one — demanding it here
    # made an otherwise valid tool_route edge raise at graph-build time.
    key = condition["condition_key"] if ctype != "tool_route" else None

    def router(state: RetrievalState) -> str:
        if ctype == "tool_route":
            calls = state.get("tool_calls") or []
            # Availability is a property of the REQUEST, not the process: a
            # name counts as in-graph only when it is enabled for this run.
            # Reading state (rather than a module-global registry) is what
            # lets per-customer tools route correctly.
            enabled = set(state.get("builtin_tools") or [])
            if any(c.get("name", "") in enabled for c in calls):
                label = "builtin"
            else:
                label = "caller" if calls else "none"
            return (
                routes.get(label)
                or routes.get("__default__")
                or next(iter(routes.values()))
            )
        val = state.get(key, state.get("scratch", {}).get(key))
        if ctype == "value":
            label = "" if val is None else str(val)
            return (
                routes.get(label)
                or routes.get("__default__")
                or next(iter(routes.values()))
            )
        if ctype == "list_empty":
            triggered = not val
        else:
            triggered = bool(val)
        result = "true" if triggered else "false"
        return routes.get(result, next(iter(routes.values())))

    return router


def _build_node_fn(node_type: str, node_id: str):
    if node_type == "MEMORY":
        return memory(node_id)
    if node_type == "RETRIEVAL":
        return retrieval(node_id)
    if node_type == "WEB_SEARCH":
        return web_search(node_id)
    if node_type == "TOOL_EXECUTOR":
        return tool_executor(node_id)
    if node_type == "HUMAN_INPUT":
        return human_input(node_id)
    if node_type == "RESPONSE_GENERATOR_WITH_REFLECTION":
        return make_reflection_node(node_type, node_id)
    return make_llm_node(node_type, node_id)


def _build_workflow(graph_record: dict, nodes: list[dict]) -> tuple[StateGraph, int]:
    """
    Assemble the (uncompiled) LangGraph StateGraph from graph_record + nodes
    loaded from DDB, returning (workflow, max_iterations). Shared by the
    stateless and durable compile variants so the graph topology is defined once.

    Supports cycles via conditional edges with condition_type "list_empty" or "bool".
    The recursion limit (max iterations through any cycle) is read from the
    graph record's maxIterations field, defaulting to 10.
    """
    node_map: dict[str, str] = {n["nodeId"]: n["nodeType"] for n in nodes}
    max_iterations = int(graph_record.get("maxIterations") or _DEFAULT_MAX_ITERATIONS)
    # maxIterations bounds trips around cycles, but it is passed to LangGraph
    # as recursion_limit, which counts EVERY superstep — a value below the
    # node count can never finish even one straight-line pass (maxIterations=1
    # on single-node graphs killed all title generation on 2026-10-14 with
    # GRAPH_RECURSION_LIMIT). Floor it so one full pass always fits.
    max_iterations = max(max_iterations, len(nodes) + 1)

    workflow = StateGraph(RetrievalState)

    for node_id, node_type in node_map.items():
        workflow.add_node(node_id, _build_node_fn(node_type, node_id))

    workflow.set_entry_point(graph_record["entryPoint"])

    edges_data = graph_record.get("edges", "{}")
    if isinstance(edges_data, str):
        edges_data = json.loads(edges_data)

    for edge in edges_data.get("edges", []):
        to_node = END if edge["to"] == "__end__" else edge["to"]
        workflow.add_edge(edge["from"], to_node)

    for cond in edges_data.get("conditional_edges", []):
        routes = cond["routes"]
        resolved_routes = {k: (END if v == "__end__" else v) for k, v in routes.items()}
        router_fn = _make_condition_router(cond, resolved_routes)
        # No path_map — router already returns the resolved destination (node ID or END)
        workflow.add_conditional_edges(cond["from"], router_fn)

    return workflow, max_iterations


def build_graph_for_customer(graph_record: dict, nodes: list[dict]):
    """Compile the stateless graph (no checkpointer) for the /retrieve fast path."""
    workflow, max_iterations = _build_workflow(graph_record, nodes)
    compiled = workflow.compile()
    logger.info(
        "Built graph=%s with %d nodes, max_iterations=%d",
        graph_record.get("graphId"), len(nodes), max_iterations,
    )
    return compiled, max_iterations


def build_durable_graph_for_customer(graph_record: dict, nodes: list[dict], checkpointer):
    """Compile the durable graph — same topology, bound to the Postgres
    checkpointer so every super-step is persisted and the run can resume after a
    crash/redeploy. Used only by the /runs path; requires a thread_id per call."""
    workflow, max_iterations = _build_workflow(graph_record, nodes)
    compiled = workflow.compile(checkpointer=checkpointer)
    logger.info(
        "Built DURABLE graph=%s with %d nodes, max_iterations=%d",
        graph_record.get("graphId"), len(nodes), max_iterations,
    )
    return compiled, max_iterations


def get_or_build_graph(customer_id: str, graph_record: dict, nodes: list[dict]) -> tuple[Any, int]:
    """Return (compiled_graph, max_iterations), building and caching if needed."""
    identity = (graph_record.get("graphId"), int(graph_record.get("latestVersion") or 0))
    cached = _graph_cache.get(customer_id)
    if cached is None or cached[0] != identity:
        compiled, max_iterations = build_graph_for_customer(graph_record, nodes)
        _graph_cache[customer_id] = (identity, compiled, max_iterations)
        return compiled, max_iterations
    return cached[1], cached[2]


def get_or_build_durable_graph(
    customer_id: str, graph_record: dict, nodes: list[dict], checkpointer
) -> tuple[Any, int]:
    """Like get_or_build_graph but returns the checkpointer-bound variant, cached
    separately so the durable and stateless compilations don't evict each other.
    The checkpointer is the process singleton (durable_runtime), stable across
    calls, so it isn't part of the cache key."""
    identity = (graph_record.get("graphId"), int(graph_record.get("latestVersion") or 0))
    cached = _durable_graph_cache.get(customer_id)
    if cached is None or cached[0] != identity:
        compiled, max_iterations = build_durable_graph_for_customer(graph_record, nodes, checkpointer)
        _durable_graph_cache[customer_id] = (identity, compiled, max_iterations)
        return compiled, max_iterations
    return cached[1], cached[2]


def invalidate_graph_cache(customer_id: str) -> None:
    """Force rebuild on next request (e.g. after user edits their graph)."""
    _graph_cache.pop(customer_id, None)
    _durable_graph_cache.pop(customer_id, None)
