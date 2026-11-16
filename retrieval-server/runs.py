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

Run id = DBOS workflow id = checkpoint thread_id = run_events run_id, for both
workflows (start_run / run_request_agent); run_cleanup depends on it. Each
workflow drops its checkpoints when it ends.

Everything here is guarded: with durable runs unconfigured (no DATABASE_URL /
DBOS not constructed) the module still imports, but agent_run is a stub and
start_run raises — routes/runs.py surfaces that as 503.
"""
import logging
import os
import time

import durable_runtime
import run_cleanup
import run_events
from encoding_library.observability import count, observe
from graph.dynamic_graph import get_or_build_durable_graph
from graph.graph_loader import get_default_graph_and_nodes, get_graph_and_nodes_by_id
from models import ExecuteAgentGraphRequest, RetrieveRequest
from routes.retrieve import (
    _FALLBACK_CONFIG,
    _FALLBACK_MEMORY_NODE_ID,
    _FALLBACK_NODE_ID,
    _FALLBACK_NODE_TYPE,
    _build_agent_graph_state,
    _build_node_configs,
    _build_state,
    _enabled_builtin_tools,
    _prepare_agent_node_configs,
)
from streaming import stream_events_dicts

logger = logging.getLogger(__name__)

# In-graph HITL (interrupt/resume) config.
_RESUME_TOPIC = "resume"
# How long a run durably waits on POST /runs/{id}/resume before giving up.
_RESUME_TIMEOUT_SEC = int(os.getenv("RUN_RESUME_TIMEOUT_SEC", "3600"))
# Safety cap on interrupt→resume cycles per run (runaway guard).
_MAX_RESUME_CYCLES = int(os.getenv("RUN_MAX_RESUME_CYCLES", "50"))


async def _pending_interrupts(graph, cfg) -> list:
    """Interrupt payloads the graph is currently paused on (empty if none)."""
    try:
        snap = await graph.aget_state(cfg)
    except Exception:
        logger.exception("could not read graph state for interrupt check")
        return []
    ints = list(getattr(snap, "interrupts", None) or [])
    if not ints:
        for t in getattr(snap, "tasks", []) or []:
            ints.extend(getattr(t, "interrupts", None) or [])
    return [getattr(i, "value", i) for i in ints]

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
    count("agent_run_started_total", source=req.request_source or "conversation")
    run_start = time.perf_counter()

    usage: dict = {}
    error: dict = {}
    cfg = {"configurable": {"thread_id": run_id}}
    graph_input = state  # dict on a fresh run; Command(resume=...) after an interrupt
    resume_cycles = 0
    while True:
        async for payload in stream_events_dicts(
            graph_input,
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

        if error:
            break
        # If the graph paused on interrupt() (a HUMAN_INPUT node), surface the
        # request and durably wait for POST /runs/{id}/resume — survives
        # crash/redeploy via DBOS.recv — then resume from the checkpoint.
        pending = await _pending_interrupts(graph, cfg)
        if not pending:
            break
        resume_cycles += 1
        if resume_cycles > _MAX_RESUME_CYCLES:
            error = {"error": "run exceeded the resume-cycle limit", "error_type": "runaway"}
            break
        _ai = pending[0]
        _ai_payload = {**_ai, "run_id": run_id} if isinstance(_ai, dict) else {"value": _ai, "run_id": run_id}
        await run_events.publish(run_id, {"awaiting_input": _ai_payload})
        count("agent_run_awaiting_input_total")
        from dbos import DBOS
        from langgraph.types import Command

        value = await DBOS.recv_async(topic=_RESUME_TOPIC, timeout_seconds=_RESUME_TIMEOUT_SEC)
        if value is None:
            error = {"error": "timed out waiting for input", "error_type": "resume_timeout"}
            break
        graph_input = Command(resume=value)

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
    count("agent_run_total", status=status, source=req.request_source or "conversation")
    observe("agent_run_duration_seconds", time.perf_counter() - run_start)
    logger.info("agent_run END run_id=%s status=%s tokens=%s", run_id, status, summary["usage"].get("total_tokens"))
    return summary


async def _request_agent_run(run_id: str, run_input: dict) -> dict:
    """
    Durable request-agent execution (titles, personas, memory extraction — see
    routes.retrieve.execute_agent_graph, which dispatches here on durable=true).
    Kept plain so it can be unit-tested without DBOS.

    Unlike agent_run there is no event stream and no interrupt handling: a
    request agent is a short internal generation whose caller awaits the
    result. Durability means the LLM calls inside run as exactly-once DBOS
    steps (credentials resolved from DynamoDB — never checkpointed), and a
    crash/redeploy re-invokes the workflow, which resumes from the LangGraph
    checkpoint (thread_id = run_id) instead of re-billing completed calls.
    """
    checkpointer = durable_runtime.get_checkpointer()
    if checkpointer is None:
        raise RuntimeError("durable runs not ready — no checkpointer")

    # Credentials are forced empty regardless of input: the workflow input is
    # checkpointed to Postgres, so a secret here would be persisted (§5.5).
    req = ExecuteAgentGraphRequest.model_validate({**run_input, "llm_credentials": {}})

    graph_data = get_graph_and_nodes_by_id(req.graph_id)
    if graph_data is None:
        raise ValueError(f"graph {req.graph_id} not found")
    graph_record, nodes = graph_data
    graph, max_iterations = get_or_build_durable_graph(
        f"graph#{req.graph_id}", graph_record, nodes, checkpointer
    )
    node_configs, response_prompt = _prepare_agent_node_configs(nodes, req.variables)
    state = _build_agent_graph_state(req, node_configs, response_prompt)

    logger.info(
        "request_agent_run START run_id=%s customer=%s graph_id=%s source=%s",
        run_id, req.customer_id, req.graph_id, req.request_source,
    )
    run_start = time.perf_counter()
    result = await graph.ainvoke(
        state,
        config={"recursion_limit": max_iterations, "configurable": {"thread_id": run_id}},
    )
    summary = {
        "generated_response": result.get("generated_response"),
        "error": result.get("error"),
        "usage": result.get("usage", {}),
    }
    status = "error" if summary["error"] else "completed"
    count("request_agent_run_total", status=status, source=req.request_source or "internal")
    observe("request_agent_run_duration_seconds", time.perf_counter() - run_start)
    logger.info("request_agent_run END run_id=%s status=%s", run_id, status)
    return summary


# --- DBOS binding (only when durable runs are configured) --------------------
if durable_runtime.dbos_constructed():
    from dbos import DBOS

    @DBOS.workflow(name="agent_run")
    async def agent_run(run_id: str, run_input: dict) -> dict:
        async with run_cleanup.checkpoints_dropped_at_end(run_id):
            return await _run_agent_graph(run_id, run_input)

    @DBOS.workflow(name="request_agent_run")
    async def request_agent_run(run_id: str, run_input: dict) -> dict:
        async with run_cleanup.checkpoints_dropped_at_end(run_id):
            return await _request_agent_run(run_id, run_input)
else:
    async def agent_run(run_id: str, run_input: dict) -> dict:  # type: ignore[misc]
        raise RuntimeError("durable runs not configured (DATABASE_URL unset)")

    async def request_agent_run(run_id: str, run_input: dict) -> dict:  # type: ignore[misc]
        raise RuntimeError("durable runs not configured (DATABASE_URL unset)")


async def start_run(run_id: str, run_input: dict):
    """Start a run in the background under workflow-id=run_id (idempotent: a
    duplicate run_id returns the existing workflow's handle). Started directly,
    not through a DBOS queue: a queue costs a worker polling Postgres every
    second and up to a poll interval of start latency. Returns the DBOS handle."""
    if not durable_runtime.is_ready():
        raise RuntimeError("durable runs not ready")
    from dbos import DBOS, SetWorkflowID

    with SetWorkflowID(run_id):
        return await DBOS.start_workflow_async(agent_run, run_id, run_input)


async def run_request_agent(run_id: str, run_input: dict) -> dict:
    """Run a request agent to completion under workflow-id=run_id."""
    from dbos import SetWorkflowID

    with SetWorkflowID(run_id):
        return await request_agent_run(run_id, run_input)
