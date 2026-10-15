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

Durability (plan 0.4): after a crash or redeploy DBOS re-executes agent_run
from the top — it does NOT resume a LangGraph checkpoint (any non-None input
starts the graph over). Re-execution is a clean, deterministic replay: the run
deletes its thread's checkpoints and runs the graph from START on the graph it
recorded (the load_graph step). Every DBOS step that completed before the crash
returns its recorded result — LLM calls (llm_invoke: the vendor is not billed
again, tool-call ids are identical), tool calls (tool_invoke: not executed
again), the human input it received (recv) — in call order. The LLM call in
flight at the crash has no record and is sent again; the tool call in flight is
refused by the attempt ledger (tool_ledger.py), so a tool that kills the
process does so once. The order of steps is fixed by the graph code, so any
change to it requires a DBOS_APP_VERSION bump (development.md).

Everything here is guarded: with durable runs unconfigured (no DATABASE_URL /
DBOS not constructed) the module still imports, but agent_run is a stub and
enqueue_run raises — routes/runs.py surfaces that as 503.
"""
import logging
import os
import time

import durable_metrics
import durable_runtime
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

QUEUE_NAME = "agent_runs"
_run_queue = None  # set by register_run_queue() after DBOS.launch()

# In-graph HITL (interrupt/resume) config.
_RESUME_TOPIC = "resume"
# How long a run durably waits on POST /runs/{id}/resume before giving up.
_RESUME_TIMEOUT_SEC = int(os.getenv("RUN_RESUME_TIMEOUT_SEC", "3600"))
# Safety cap on interrupt→resume cycles per run (runaway guard).
_MAX_RESUME_CYCLES = int(os.getenv("RUN_MAX_RESUME_CYCLES", "50"))
# User-facing text of the run's own failures (shown by the proxy, contract C5).
_RESUME_TIMEOUT_MESSAGE = "This response stopped because it waited too long for your input."
_RUNAWAY_MESSAGE = "This response stopped because it asked for input too many times."


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


def _load_graph_data(customer_id: str, graph_id):
    """The run's graph record and nodes from DynamoDB (ownership-checked), plus
    the node configs built from them (instruction refs resolved). None when
    the customer has no graph (direct-LLM fallback).

    On the durable path this is the run's first DBOS step, `load_graph`: a
    re-execution gets the recorded copy, not whatever the customer saved since
    — the replay is only deterministic on the graph it recorded. The records
    hold no credentials (BYOK and tool keys resolve at call time); the one
    exception is a legacy WEB_SEARCH node's optional inline `api_key`, which
    state["node_configs"] already writes into every checkpoint."""
    if graph_id:
        graph_data = get_graph_and_nodes_by_id(graph_id)
        owner = graph_data[0].get("customerId") if graph_data else None
        if graph_data is None or owner not in (customer_id, "System"):
            raise ValueError(f"Agent '{graph_id}' not found")
    else:
        graph_data = get_default_graph_and_nodes(customer_id)
    if graph_data is None:
        return None
    graph_record, nodes = graph_data
    node_type_map, node_configs, streaming_nodes = _build_node_configs(
        nodes, graph_record.get("customerId")
    )
    return graph_record, nodes, node_type_map, node_configs, streaming_nodes


if durable_runtime.dbos_constructed():
    from dbos import DBOS

    _load_graph_step = DBOS.step(name="load_graph")(_load_graph_data)
else:
    _load_graph_step = _load_graph_data


def _resolve_durable_graph(customer_id: str, graph_id, checkpointer):
    """Durable counterpart of routes.retrieve._resolve_graph: same DDB loading
    and ownership check (as the recorded load_graph step), but compiles the
    checkpointer-bound variant."""
    loaded = _load_graph_step(customer_id, graph_id)
    if loaded is None:
        logger.info("No graph for customer=%s — durable direct-LLM fallback", customer_id)
        return _durable_direct_graph(checkpointer)

    graph_record, nodes, node_type_map, node_configs, streaming_nodes = loaded
    cache_key = f"graph#{graph_id}" if graph_id else customer_id
    graph, max_iterations = get_or_build_durable_graph(cache_key, graph_record, nodes, checkpointer)
    node_name_map = {n["nodeId"]: n.get("name") or n["nodeType"] for n in nodes}
    return graph, node_type_map, node_name_map, node_configs, streaming_nodes, max_iterations


def _in_durable_workflow() -> bool:
    """True while executing as the agent_run DBOS workflow (not in unit tests,
    which call the body directly)."""
    if not durable_runtime.dbos_constructed():
        return False
    from dbos import DBOS

    return DBOS.workflow_id is not None


async def _reset_for_replay(graph, checkpointer, cfg: dict, run_id: str) -> bool:
    """Clean replay (plan 0.4). If the run's thread already has checkpoint
    values, this execution is a re-execution after a crash or redeploy:
    delete the thread (every namespace, subagents' included) so the graph runs
    from START on empty state while its steps replay from the DBOS memo in
    call order. Resuming the old checkpoint instead would misalign the memo
    (measured: tool calls executed three times), and replaying onto it would
    duplicate the append-only channels (history [A, A, B]). Returns True for a
    re-execution."""
    snap = await graph.aget_state(cfg)
    if not getattr(snap, "values", None):
        return False
    await checkpointer.adelete_thread(run_id)
    durable_metrics.run_recovered()
    logger.warning("agent_run run_id=%s: re-executing after a restart, replaying from the step memo", run_id)
    return True


async def _run_agent_graph(run_id: str, run_input: dict) -> dict:
    """The workflow body (kept plain so it can be unit-tested without DBOS).
    Streams graph events into run_events and returns a summary."""
    try:
        return await _agent_run_body(run_id, run_input)
    except Exception:
        # The workflow ends ERROR without a terminal row; the run sweep (and a
        # live tail) end its stream with an error. Counted here so the
        # agent_run error rate sees workflow failures, not just failed turns.
        count("agent_run_total", status="error", source=run_input.get("request_source") or "conversation")
        raise


async def _agent_run_body(run_id: str, run_input: dict) -> dict:
    checkpointer = durable_runtime.get_checkpointer()
    if checkpointer is None:
        raise RuntimeError("durable runs not ready — no checkpointer")

    # Reconstruct the request. Credentials are intentionally empty so the graph
    # resolves them from DynamoDB by customer_id (never checkpointed).
    req = RetrieveRequest.model_validate({**run_input, "llm_credentials": {}, "stream": True})

    (graph, node_type_map, node_name_map, node_configs, streaming_nodes,
     max_iterations) = _resolve_durable_graph(req.customer_id, req.graph_id, checkpointer)
    builtin_tools = _enabled_builtin_tools(node_type_map, node_configs, req)
    state = _build_state(req, node_configs, builtin_tools)

    logger.info("agent_run START run_id=%s customer=%s graph_id=%s", run_id, req.customer_id, req.graph_id)
    count("agent_run_started_total", source=req.request_source or "conversation")
    run_start = time.perf_counter()

    usage: dict = {}
    error: dict = {}
    # True once the error above went out as its own row (stream errors do).
    error_published = False
    cfg = {"configurable": {"thread_id": run_id}}
    # Clean replay (plan 0.4): once per execution, BEFORE the interrupt loop —
    # never inside it: after an interrupt the thread always has values, and
    # deleting it there would break Command(resume=...).
    replayed = _in_durable_workflow() and await _reset_for_replay(graph, checkpointer, cfg, run_id)
    if replayed:
        # The crashed attempt's rows stay in the channel, and the proxy keeps
        # the text streamed so far until a content_reset: without this, an
        # answer cut off by the crash would be stored as that prefix followed
        # by the whole re-generated answer.
        await run_events.publish(run_id, {"content_reset": True})
    # Whether answer text went out since the last content_reset (see the
    # memoized-answer case below).
    content_since_reset = False
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
            if "usage" in payload:
                # Counts only LLM calls that streamed: a replayed (memoized)
                # call fires no model events. Published once, from the
                # checkpointed state, below.
                usage = payload["usage"]
                continue
            await run_events.publish(run_id, payload)
            if "content" in payload:
                content_since_reset = True
            elif "content_reset" in payload:
                content_since_reset = False
            if "error" in payload:
                error = payload
                error_published = True

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
            error = {"error": _RUNAWAY_MESSAGE, "error_type": "runaway"}
            break
        _ai = pending[0]
        _ai_payload = {**_ai, "run_id": run_id} if isinstance(_ai, dict) else {"value": _ai, "run_id": run_id}
        await run_events.publish(run_id, {"awaiting_input": _ai_payload})
        count("agent_run_awaiting_input_total")
        from dbos import DBOS
        from langgraph.types import Command

        value = await DBOS.recv_async(topic=_RESUME_TOPIC, timeout_seconds=_RESUME_TIMEOUT_SEC)
        if value is None:
            error = {"error": _RESUME_TIMEOUT_MESSAGE, "error_type": "resume_timeout"}
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
        # The checkpointed usage channel accumulates every LLM response,
        # replayed or not; the stream's total misses replayed calls.
        "usage": final.get("usage") or usage,
        "error": error.get("error"),
        "error_type": error.get("error_type"),
    }
    # A node-level error (e.g. a failed retrieval) that still produced an
    # answer or tool calls is not a failed turn: the proxy reads status
    # "error" or an "error" text as a failure (contract C5) and would show
    # the answer as failed. It travels as a warning instead.
    node_error = final.get("error")
    if node_error and not error:
        if summary["generated_response"] or summary["tool_calls"]:
            summary["warning"] = node_error
        else:
            summary["error"] = node_error
            summary["error_type"] = "error"
    status = "error" if summary["error"] else "completed"
    if replayed and not content_since_reset and not error and summary["generated_response"]:
        # The final answer itself replayed from the memo (the crash came after
        # it, before the run ended): its text never streamed in this
        # execution, and the content_reset above cleared the first one's.
        await run_events.publish(run_id, {"content": summary["generated_response"]})
    await run_events.publish(run_id, {"usage": summary["usage"]})
    if error and not error_published:
        # The run's own failure (resume timeout, runaway guard) goes out as a
        # standalone error row before the summary (contract C5): inside the
        # summary the proxy's parser can take another key first.
        await run_events.publish(run_id, {"error": error["error"], "error_type": error["error_type"]})
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
    result. Its LLM calls run as DBOS steps (credentials resolved from
    DynamoDB — never checkpointed). It is never re-executed: after a crash its
    HTTP caller is gone, so request_agent_run has max_recovery_attempts=0 and
    the next start dead-letters it. Its DBOS rows and checkpoints are deleted
    by the caller once it has the result (routes.retrieve.execute_agent_graph),
    or by the run sweep an hour later when the process died first.
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
    node_configs, response_prompt = _prepare_agent_node_configs(
        nodes, req.variables, graph_record.get("customerId")
    )
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
# Recovery caps (plan 0.1). Every restart while a run is PENDING re-dispatches
# it and costs one attempt; DBOS dead-letters it (status
# MAX_RECOVERY_ATTEMPTS_EXCEEDED, without executing it again) on the dispatch
# after K+1 executions. So a run that kills the process causes at most K+1
# crashes — 101 with the DBOS default of 100.
#   agent_run: 3 -> at most 4 executions. Not lower: deploys and innocent runs
#     caught in someone else's crash use up attempts too, and a run waiting on
#     human input can stay PENDING for hours.
#   request_agent_run: 0 -> dead-lettered on the first restart, never re-run.
#     Its HTTP caller is gone after a crash, so nobody would get the result.
#     Safe only because production is ONE machine with executor id "local"
#     (development.md, "Durable runs: deploy rules"): with a second machine a
#     peer's restart would dead-letter a live request.
# Changing either value changes the computed DBOS app version, which is why
# production pins DBOS_APP_VERSION (durable_runtime.py).
AGENT_RUN_MAX_RECOVERY_ATTEMPTS = 3
REQUEST_AGENT_RUN_MAX_RECOVERY_ATTEMPTS = 0

if durable_runtime.dbos_constructed():
    from dbos import DBOS

    @DBOS.workflow(name="agent_run", max_recovery_attempts=AGENT_RUN_MAX_RECOVERY_ATTEMPTS)
    async def agent_run(run_id: str, run_input: dict) -> dict:
        return await _run_agent_graph(run_id, run_input)

    @DBOS.workflow(name="request_agent_run", max_recovery_attempts=REQUEST_AGENT_RUN_MAX_RECOVERY_ATTEMPTS)
    async def request_agent_run(run_id: str, run_input: dict) -> dict:
        return await _request_agent_run(run_id, run_input)
else:
    async def agent_run(run_id: str, run_input: dict) -> dict:  # type: ignore[misc]
        raise RuntimeError("durable runs not configured (DATABASE_URL unset)")

    async def request_agent_run(run_id: str, run_input: dict) -> dict:  # type: ignore[misc]
        raise RuntimeError("durable runs not configured (DATABASE_URL unset)")


async def delete_run_data(run_id: str) -> None:
    """Purge everything this service stores for one durable run (plan 3.9):
    its DBOS rows — input (the user's request), output, step outputs
    (memoized LLM responses and tool results), messages and child workflows —
    its LangGraph checkpoints (every namespace, subagents' included), its
    run_events rows and its tool-ledger rows. Each delete is idempotent."""
    import tool_ledger
    from dbos import DBOS

    await DBOS.delete_workflows_async([run_id], delete_children=True)
    await durable_runtime.get_checkpointer().adelete_thread(run_id)
    await run_events.delete_run(run_id)
    await tool_ledger.delete_workflow(run_id)


async def delete_request_run(workflow_id: str, thread_id: str | None = None) -> None:
    """Delete a request agent's DBOS rows and checkpoints (plan 3.9): its input
    holds conversation text and nothing reads them once its caller has the
    result. `thread_id` defaults to the workflow id (they are the same since
    execute_agent_graph runs the workflow under SetWorkflowID(run_id)).
    Checkpoints go first, so a failure leaves the DBOS row the run sweep finds
    them by."""
    from dbos import DBOS

    checkpointer = durable_runtime.get_checkpointer()
    if checkpointer is not None:
        await checkpointer.adelete_thread(thread_id or workflow_id)
    await DBOS.delete_workflows_async([workflow_id], delete_children=True)


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
