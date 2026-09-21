"""
Durable agent runs — the DBOS workflow that drives a checkpointer-bound graph
(see DURABLE_AGENTS_DBOS_PLAN §5.4).

One `agent_run` workflow per run:
  * rebuilds the customer's graph as the DURABLE (checkpointer-bound) variant,
  * builds the initial RetrievalState WITHOUT credentials — nodes resolve BYOK
    keys from DynamoDB by customer_id (graph.credentials.credentials_for), so no
    secret is ever written to a checkpoint or a DBOS input/output (§5.5),
  * streams graph events (reusing streaming.stream_events_dicts — the exact same
    event protocol as /retrieve) and appends each to the run_events channel so
    the SSE endpoint can tail / reattach,
  * returns a summary read back from the checkpointed final state.

Durability: DBOS re-invokes agent_run after a crash/redeploy; because the graph
is checkpointer-bound and keyed by thread_id=run_id, astream_events RESUMES from
the last LangGraph checkpoint instead of restarting — completed nodes are not
re-run. (Exactly-once LLM billing and in-graph interrupt()/resume are P2.)

Everything here is guarded: with durable runs unconfigured (no DATABASE_URL /
DBOS not constructed) the module still imports, but agent_run is a stub and
enqueue_run raises — routes/runs.py surfaces that as 503.
"""
import logging

import durable_runtime
import run_events
from graph.dynamic_graph import get_or_build_durable_graph
from graph.graph_loader import get_default_graph_and_nodes, get_graph_and_nodes_by_id
from models import RetrieveRequest
from routes.retrieve import (
    _FALLBACK_CONFIG,
    _FALLBACK_MEMORY_NODE_ID,
    _FALLBACK_NODE_ID,
    _FALLBACK_NODE_TYPE,
    _build_node_configs,
    _build_state,
    _enabled_builtin_tools,
)
from streaming import stream_events_dicts

logger = logging.getLogger(__name__)

QUEUE_NAME = "agent_runs"
_run_queue = None  # set by register_run_queue() after DBOS.launch()

# Durable direct-LLM fallback (memory + one generation node), compiled once with
# the checkpointer. Mirrors routes.retrieve._direct_graph for customers with no
# configured agent graph. Keyed by nothing — the checkpointer is a singleton.
_durable_fallback = None


def _durable_direct_graph(checkpointer):
    """Durable variant of the direct-LLM pipeline (memory + generation)."""
    global _durable_fallback
    if _durable_fallback is None:
        from langgraph.graph import END, StateGraph

        from graph.nodes.llm_node import make_llm_node
        from graph.nodes.memory import memory
        from graph.state import RetrievalState

        builder = StateGraph(RetrievalState)
        builder.add_node(_FALLBACK_MEMORY_NODE_ID, memory(_FALLBACK_MEMORY_NODE_ID))
        builder.add_node(_FALLBACK_NODE_ID, make_llm_node(_FALLBACK_NODE_TYPE))
        builder.set_entry_point(_FALLBACK_MEMORY_NODE_ID)
        builder.add_edge(_FALLBACK_MEMORY_NODE_ID, _FALLBACK_NODE_ID)
        builder.add_edge(_FALLBACK_NODE_ID, END)
        _durable_fallback = builder.compile(checkpointer=checkpointer)
    node_type_map = {_FALLBACK_MEMORY_NODE_ID: "MEMORY", _FALLBACK_NODE_ID: _FALLBACK_NODE_TYPE}
    node_name_map = {_FALLBACK_MEMORY_NODE_ID: "Memory", _FALLBACK_NODE_ID: "Response Generator"}
    node_configs = {_FALLBACK_NODE_TYPE: _FALLBACK_CONFIG}
    streaming_nodes = {_FALLBACK_NODE_ID}
    from graph.dynamic_graph import _DEFAULT_MAX_ITERATIONS
    return _durable_fallback, node_type_map, node_name_map, node_configs, streaming_nodes, _DEFAULT_MAX_ITERATIONS


def _resolve_durable_graph(customer_id: str, graph_id, checkpointer):
    """Durable counterpart of routes.retrieve._resolve_graph: same DDB loading
    and ownership check, but compiles the checkpointer-bound variant."""
    if graph_id:
        graph_data = get_graph_and_nodes_by_id(graph_id)
        owner = graph_data[0].get("customerId") if graph_data else None
        if graph_data is None or owner not in (customer_id, "System"):
            raise ValueError(f"Agent '{graph_id}' not found")
    else:
        graph_data = get_default_graph_and_nodes(customer_id)
    if graph_data is None:
        logger.info("No graph for customer=%s — durable direct-LLM fallback", customer_id)
        return _durable_direct_graph(checkpointer)

    graph_record, nodes = graph_data
    cache_key = f"graph#{graph_id}" if graph_id else customer_id
    graph, max_iterations = get_or_build_durable_graph(cache_key, graph_record, nodes, checkpointer)
    node_type_map, node_configs, streaming_nodes = _build_node_configs(nodes)
    node_name_map = {n["nodeId"]: n.get("name") or n["nodeType"] for n in nodes}
    return graph, node_type_map, node_name_map, node_configs, streaming_nodes, max_iterations


async def _run_agent_graph(run_id: str, run_input: dict) -> dict:
    """The workflow body (kept plain so it can be unit-tested without DBOS).
    Streams graph events into run_events and returns a summary."""
    checkpointer = durable_runtime.get_checkpointer()
    if checkpointer is None:
        raise RuntimeError("durable runs not ready — no checkpointer")

    # Reconstruct the request. Credentials are intentionally empty so the graph
    # resolves them from DynamoDB by customer_id (never checkpointed).
    req = RetrieveRequest.model_validate({**run_input, "llm_credentials": {}, "stream": True})

    (graph, node_type_map, node_name_map, node_configs, streaming_nodes,
     max_iterations) = _resolve_durable_graph(req.customer_id, req.graph_id, checkpointer)
    builtin_tools = _enabled_builtin_tools(node_type_map, node_configs)
    state = _build_state(req, node_configs, builtin_tools)

    logger.info("agent_run START run_id=%s customer=%s graph_id=%s", run_id, req.customer_id, req.graph_id)

    usage: dict = {}
    error: dict = {}
    async for payload in stream_events_dicts(
        state,
        graph=graph,
        node_type_map=node_type_map,
        node_name_map=node_name_map,
        streaming_nodes=streaming_nodes,
        recursion_limit=max_iterations,
        structured_output=bool(req.response_schema),
        builtin_tool_names=set(builtin_tools),
        thread_id=run_id,
    ):
        await run_events.publish(run_id, payload)
        if "usage" in payload:
            usage = payload["usage"]
        if "error" in payload:
            error = payload

    # Authoritative final state from the checkpoint (post-resume-safe).
    final: dict = {}
    try:
        snap = await graph.aget_state({"configurable": {"thread_id": run_id}})
        final = getattr(snap, "values", None) or {}
    except Exception:
        logger.exception("agent_run run_id=%s: could not read final checkpoint state", run_id)

    summary = {
        "run_id": run_id,
        "customer_id": req.customer_id,
        "generated_response": final.get("generated_response"),
        "tool_calls": final.get("tool_calls"),
        "generated_artifacts": final.get("generated_artifacts", []),
        "usage": usage or final.get("usage", {}),
        "error": error.get("error") or final.get("error"),
        "error_type": error.get("error_type"),
    }
    status = "error" if summary["error"] else "completed"
    await run_events.publish(run_id, {"status": status, **summary}, terminal=True)
    logger.info("agent_run END run_id=%s status=%s tokens=%s", run_id, status, summary["usage"].get("total_tokens"))
    return summary


# --- DBOS binding (only when durable runs are configured) --------------------
if durable_runtime.dbos_constructed():
    from dbos import DBOS

    @DBOS.workflow(name="agent_run")
    async def agent_run(run_id: str, run_input: dict) -> dict:
        return await _run_agent_graph(run_id, run_input)
else:
    async def agent_run(run_id: str, run_input: dict) -> dict:  # type: ignore[misc]
        raise RuntimeError("durable runs not configured (DATABASE_URL unset)")


async def register_run_queue() -> None:
    """Register the agent-runs queue. Called from durable_runtime.startup AFTER
    DBOS.launch() (queues touch the system DB, so they can't be registered at
    import time). Uses the async API because startup runs inside the event loop."""
    global _run_queue
    if not durable_runtime.dbos_constructed():
        return
    import os

    from dbos import DBOS

    # global_concurrency bounds how many runs execute at once across the fleet —
    # a safety cap on concurrent LLM workloads; tuned further in P3.
    _run_queue = await DBOS.register_queue_async(
        QUEUE_NAME, global_concurrency=int(os.getenv("AGENT_RUNS_CONCURRENCY", "20"))
    )
    logger.info("agent_runs queue registered")


async def enqueue_run(run_id: str, run_input: dict):
    """Durably enqueue a run under workflow-id=run_id (idempotent: a duplicate
    run_id returns the existing workflow handle). Returns the DBOS handle."""
    if _run_queue is None:
        raise RuntimeError("durable runs not ready — queue not registered")
    from dbos import SetWorkflowID

    with SetWorkflowID(run_id):
        return await _run_queue.enqueue_async(agent_run, run_id, run_input)
