import json
import logging
from typing import Any

from langgraph.graph import END, StateGraph

from graph.nodes.llm_node import make_llm_node
from graph.nodes.reflection_node import make_reflection_node
from graph.nodes.retrieval import retrieval
from graph.state import RetrievalState

logger = logging.getLogger(__name__)

_graph_cache: dict[str, tuple[Any, int]] = {}  # customer_id -> (compiled_graph, max_iterations)

# safety cap on how many times the graph can loop through a cycle before LangGraph forcibly aborts the run
_DEFAULT_MAX_ITERATIONS = 10


def _make_condition_router(condition: dict, routes: dict[str, str]):
    """
    Return a routing function for a conditional edge.

    condition fields:
      condition_key   (str)  — state field to evaluate
      condition_type  (str)  — "bool" (default) | "list_empty"
        "bool"       : triggers "true" branch when the field is truthy
        "list_empty" : triggers "true" branch when the field is an empty list or None
    """
    key = condition["condition_key"]
    ctype = condition.get("condition_type", "bool")

    def router(state: RetrievalState) -> str:
        val = state.get(key)
        if ctype == "list_empty":
            triggered = not val
        else:
            triggered = bool(val)
        result = "true" if triggered else "false"
        return routes.get(result, next(iter(routes.values())))

    return router


def _build_node_fn(node_type: str):
    if node_type == "RETRIEVAL":
        return retrieval
    if node_type == "RESPONSE_GENERATOR_WITH_REFLECTION":
        return make_reflection_node(node_type)
    return make_llm_node(node_type)


def build_graph_for_customer(graph_record: dict, nodes: list[dict]):
    """
    Compile a LangGraph StateGraph from graph_record + nodes loaded from DDB.

    Supports cycles via conditional edges with condition_type "list_empty" or "bool".
    The recursion limit (max iterations through any cycle) is read from the
    graph record's maxIterations field, defaulting to 10.
    """
    node_map: dict[str, str] = {n["nodeId"]: n["nodeType"] for n in nodes}
    max_iterations = int(graph_record.get("maxIterations") or _DEFAULT_MAX_ITERATIONS)

    workflow = StateGraph(RetrievalState)

    for node_id, node_type in node_map.items():
        workflow.add_node(node_id, _build_node_fn(node_type))

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

    compiled = workflow.compile()
    logger.info(
        "Built graph=%s with %d nodes, max_iterations=%d",
        graph_record.get("graphId"), len(node_map), max_iterations,
    )
    return compiled, max_iterations


def get_or_build_graph(customer_id: str, graph_record: dict, nodes: list[dict]) -> tuple[Any, int]:
    """Return (compiled_graph, max_iterations), building and caching if needed."""
    if customer_id not in _graph_cache:
        _graph_cache[customer_id] = build_graph_for_customer(graph_record, nodes)
    return _graph_cache[customer_id]


def invalidate_graph_cache(customer_id: str) -> None:
    """Force rebuild on next request (e.g. after user edits their graph)."""
    _graph_cache.pop(customer_id, None)
