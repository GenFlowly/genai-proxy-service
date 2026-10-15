"""
Subprocess harness for the durable-run integration tests (tests/test_durable_*.py).

One invocation is ONE lifetime of the retrieval-server's durable runtime: DBOS on
an SQLite system database, through the real durable_runtime and runs modules, so
the real workflow registrations (names, recovery caps, app version) apply. A
scenario's step hard-exits the process with os._exit(137) — what an OOM kill or
a host failure does — and the test's next invocation of the same scenario starts
a new process whose DBOS.launch() recovers the run, exactly as a restarted Fly
machine does.

    cd retrieval-server
    python -m tests.durable_harness <scenario> --dir <scratch dir> --phase start|recover

The last stdout line starting with RESULT_PREFIX carries the scenario's JSON
result. Everything a scenario observes across processes (executions, side
effects) is appended to files in --dir.
"""
import argparse
import asyncio
import json
import os
import sys
import time

RESULT_PREFIX = "DURABLE_HARNESS_RESULT "
RUN_ID = "run_harness"
RUN_INPUT = {
    "customer_id": "cust-1",
    "client": "test",
    "data_type": "conversation",
    "raw_data": {"query_data": "hi"},
    "llm_provider": "anthropic",
    "agentic": True,
}


def append_line(directory: str, name: str, record: dict) -> None:
    """Append one JSON line, flushed to disk before returning (the process may
    hard-exit right after)."""
    with open(os.path.join(directory, name), "a") as f:
        f.write(json.dumps(record) + "\n")
        f.flush()
        os.fsync(f.fileno())


def read_lines(directory: str, name: str) -> list[dict]:
    path = os.path.join(directory, name)
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def emit_result(result: dict) -> None:
    print(RESULT_PREFIX + json.dumps(result, default=str), flush=True)


def parse_result(stdout: str) -> dict | None:
    for line in reversed(stdout.splitlines()):
        if line.startswith(RESULT_PREFIX):
            return json.loads(line[len(RESULT_PREFIX):])
    return None


async def wait_for_status(workflow_id: str, statuses: set[str], timeout: float = 45.0):
    """Poll DBOS until the workflow reaches one of `statuses` (or time out)."""
    from dbos import DBOS

    deadline = time.monotonic() + timeout
    st = None
    while time.monotonic() < deadline:
        st = await DBOS.get_workflow_status_async(workflow_id)
        if st is not None and st.status in statuses:
            return st
        await asyncio.sleep(0.2)
    return st


_TERMINAL = {"SUCCESS", "ERROR", "CANCELLED", "MAX_RECOVERY_ATTEMPTS_EXCEEDED"}


def _status_dict(st) -> dict:
    if st is None:
        return {"status": None}
    return {
        "status": st.status,
        "recovery_attempts": st.recovery_attempts,
        "app_version": st.app_version,
        "executor_id": st.executor_id,
    }


async def setup_app_db(directory: str):
    """run_events on an SQLite file through the psycopg-pool adapter — the
    module's real SQL (tests/sqlite_pool.py)."""
    import run_events
    from tests.sqlite_pool import SqlitePool

    pool = SqlitePool(os.path.join(directory, "app.sqlite"))
    await run_events.setup(pool)
    return pool


async def run_event_rows(run_id: str = RUN_ID) -> list[dict]:
    import run_events

    return [
        {"seq": r["seq"], "event": r["event"], "terminal": bool(r["terminal"])}
        for r in await run_events.read_since(run_id, 0, limit=10_000)
    ]


# --- scenarios ----------------------------------------------------------------

def scenario_poison(args) -> None:
    """agent_run whose step kills the process on every execution (plan 0.1)."""
    import runs
    from dbos import DBOS

    @DBOS.step(name="poison_step")
    async def poison_step():
        append_line(args.dir, "executions.log", {"pid": os.getpid()})
        os._exit(137)

    async def poisoned_body(run_id, run_input):
        await poison_step()
        return {}

    runs._run_agent_graph = poisoned_body

    async def main():
        import durable_metrics
        import durable_runtime

        DBOS.launch()
        await runs.register_run_queue()
        if args.phase == "start":
            await runs.enqueue_run(RUN_ID, dict(RUN_INPUT))
        st = await wait_for_status(RUN_ID, _TERMINAL)
        result = {**_status_dict(st), "current_app_version": DBOS.application_version}
        if st is not None and st.status == "MAX_RECOVERY_ATTEMPTS_EXCEEDED":
            # The run sweep (plan 0.2) over this real dead letter: two passes of
            # this process, then one as a freshly started process would run it.
            await setup_app_db(args.dir)
            state = durable_runtime.SweepState()
            await durable_runtime.sweep_once(state)
            await durable_runtime.sweep_once(state)
            await durable_runtime.sweep_once(durable_runtime.SweepState())
            result["rows"] = await run_event_rows()
            result["dead_lettered_metric"] = (
                durable_metrics.DURABLE_RUN_DEAD_LETTERED.labels(workflow="agent_run")._value.get()
            )
        emit_result(result)
        DBOS.destroy()

    asyncio.run(main())


def scenario_poison_request(args) -> None:
    """request_agent_run (started directly, like routes/retrieve.py) whose step
    kills the process: with max_recovery_attempts=0 the next start
    dead-letters it without running it again."""
    import runs
    from dbos import DBOS, SetWorkflowID

    @DBOS.step(name="poison_step")
    async def poison_step():
        append_line(args.dir, "executions.log", {"pid": os.getpid()})
        os._exit(137)

    async def poisoned_body(run_id, run_input):
        await poison_step()
        return {}

    runs._request_agent_run = poisoned_body

    async def main():
        DBOS.launch()
        await runs.register_run_queue()
        if args.phase == "start":
            with SetWorkflowID(RUN_ID):
                await runs.request_agent_run(RUN_ID, dict(RUN_INPUT))
        st = await wait_for_status(RUN_ID, _TERMINAL)
        emit_result(_status_dict(st))
        DBOS.destroy()

    asyncio.run(main())


def scenario_cancel(args) -> None:
    """POST /runs/{id}/cancel against a live agent_run waiting in recv."""
    import durable_runtime
    import run_events
    import runs
    from dbos import DBOS
    from routes import runs as runs_routes

    async def waiting_body(run_id, run_input):
        await DBOS.recv_async(topic="never", timeout_seconds=60)
        return {}

    runs._run_agent_graph = waiting_body

    async def no_events(run_id):
        return None

    run_events.delete_run = no_events

    async def main():
        DBOS.launch()
        await runs.register_run_queue()
        durable_runtime._ready = True
        await runs.enqueue_run(RUN_ID, dict(RUN_INPUT))
        before = await wait_for_status(RUN_ID, {"PENDING"})
        response = await runs_routes.cancel_run(RUN_ID)
        after = await wait_for_status(RUN_ID, {"CANCELLED"}, timeout=10)
        emit_result({"before": _status_dict(before), "response": response, "after": _status_dict(after)})
        DBOS.destroy()

    asyncio.run(main())


def scenario_stranded(args) -> None:
    """An agent_run interrupted under one DBOS_APP_VERSION, then a process on a
    bumped version: never recovered, so the sweep cancels it and ends it with
    the error rows (plan 0.2)."""
    import durable_runtime
    import runs
    from dbos import DBOS

    async def waiting_body(run_id, run_input):
        append_line(args.dir, "executions.log", {"pid": os.getpid()})
        await DBOS.recv_async(topic="never", timeout_seconds=60)
        return {}

    runs._run_agent_graph = waiting_body

    async def main():
        DBOS.launch()
        await runs.register_run_queue()
        if args.phase == "start":
            await runs.enqueue_run(RUN_ID, dict(RUN_INPUT))
            await wait_for_status(RUN_ID, {"PENDING"})
            os._exit(137)  # the machine is replaced while the run waits
        await asyncio.sleep(2)  # give a (wrong) recovery the chance to happen
        before = await DBOS.get_workflow_status_async(RUN_ID)
        await setup_app_db(args.dir)
        durable_runtime.STRANDED_AFTER_SEC = 0
        await durable_runtime.sweep_once(durable_runtime.SweepState())
        after = await DBOS.get_workflow_status_async(RUN_ID)
        emit_result({
            "before": _status_dict(before),
            "after": _status_dict(after),
            "current_app_version": DBOS.application_version,
            "rows": await run_event_rows(),
        })
        DBOS.destroy()

    asyncio.run(main())


# --- deterministic replay (plan 0.4) ------------------------------------------
#
# A real durable agent_run — runs._run_agent_graph on a real dynamic graph
# (RESPONSE_GENERATOR <-> TOOL_EXECUTOR, llm_node and tool_executor as shipped)
# — with three fakes: a scripted streaming chat model behind the llm_invoke
# step, a `fake_tool` that stores one file and can hard-exit after storing it,
# and file-backed stand-ins for S3 and the LangGraph checkpointer, so state
# survives the hard exit like Postgres does. Variants:
#   main        two tool rounds; crash in the round-2 tool step after its put
#   divergence  as main, but the next process records tool steps under another
#               name: the replay must fail the run, not feed the model an error
#   stream      crash while the final answer is streaming
#   late_crash  crash after the final answer, before the run ended
#   hitl        HUMAN_INPUT node; crash in the LLM call after recv
#   subagent    spawn_agent child with two tool rounds; crash in the child's
#               round-2 tool step

GRAPH_ID = "graph-harness"
CUSTOMER_ID = "cust-1"
# Marker in every fake_tool call's arguments: it must never reach the ledger.
ARG_MARKER = "ARG-SECRET-7f3a"
FINAL_ANSWER = "All done: both rounds are complete."
STREAM_ANSWER = (
    "The answer is forty-two, and the reasoning behind it takes a few sentences "
    "to stream so that a crash can cut it off halfway through."
)
INTERRUPTED_PREFIX = "Error executing fake_tool: "
HITL_VALUE = "blue"


def _graph_records(variant: str):
    gen_config = {"is_streaming": True, "output_key": "generated_response"}
    if variant == "hitl":
        nodes = [
            {"nodeId": "ask", "nodeType": "HUMAN_INPUT", "name": "Ask",
             "config": json.dumps({"prompt": "Which colour?"})},
            {"nodeId": "gen", "nodeType": "RESPONSE_GENERATOR", "name": "Gen",
             "config": json.dumps({**gen_config,
                                   "input_template": "{original_query} The user chose: {human_response}"})},
        ]
        edges = {"edges": [{"from": "ask", "to": "gen"}, {"from": "gen", "to": "__end__"}]}
        entry = "ask"
    else:
        tools_config = {"tools": ["fake_tool"]}
        if variant == "subagent":
            tools_config = {"tools": ["spawn_agent"], "subagents": [
                {"name": "worker", "description": "Does delegated work.", "tools": ["fake_tool"]},
            ]}
        nodes = [
            {"nodeId": "gen", "nodeType": "RESPONSE_GENERATOR", "name": "Gen", "config": json.dumps(gen_config)},
            {"nodeId": "tools", "nodeType": "TOOL_EXECUTOR", "name": "Tools", "config": json.dumps(tools_config)},
        ]
        edges = {
            "edges": [{"from": "tools", "to": "gen"}],
            "conditional_edges": [{"from": "gen", "condition_type": "tool_route",
                                   "routes": {"builtin": "tools", "caller": "__end__", "none": "__end__"}}],
        }
        entry = "gen"
    record = {"graphId": GRAPH_ID, "customerId": CUSTOMER_ID, "entryPoint": entry,
              "latestVersion": 1, "maxIterations": 30, "edges": json.dumps(edges)}
    return record, nodes


def _make_file_saver(path: str):
    """InMemorySaver that persists to a pickle after every write, so a
    checkpoint survives the process like the Postgres checkpointer's does."""
    import pickle

    from langgraph.checkpoint.memory import InMemorySaver

    class FileSaver(InMemorySaver):
        def __init__(self):
            super().__init__()
            if os.path.exists(path):
                with open(path, "rb") as f:
                    storage, writes, blobs = pickle.load(f)
                for thread, namespaces in storage.items():
                    for ns, checkpoints in namespaces.items():
                        self.storage[thread][ns].update(checkpoints)
                self.writes.update(writes)
                self.blobs.update(blobs)

        def _sync(self):
            storage = {t: {ns: dict(cps) for ns, cps in nss.items()} for t, nss in self.storage.items()}
            data = (storage, {k: dict(v) for k, v in self.writes.items()}, dict(self.blobs))
            with open(path + ".tmp", "wb") as f:
                pickle.dump(data, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(path + ".tmp", path)

        def put(self, *a, **k):
            out = super().put(*a, **k)
            self._sync()
            return out

        def put_writes(self, *a, **k):
            super().put_writes(*a, **k)
            self._sync()

        def delete_thread(self, thread_id):
            super().delete_thread(thread_id)
            self._sync()

    return FileSaver()


class FileStore:
    """Stand-in for the S3 artifact store: one file per key, every put logged."""

    def __init__(self, directory: str):
        self.directory = directory

    def put(self, key, data, content_type, **kwargs):
        path = os.path.join(self.directory, "s3", key)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        append_line(self.directory, "s3_puts.log", {"pid": os.getpid(), "key": key})

    def get(self, key):
        with open(os.path.join(self.directory, "s3", key), "rb") as f:
            return f.read()

    def list(self, prefix):
        root = os.path.join(self.directory, "s3")
        out = []
        for base, _, files in os.walk(root):
            for name in files:
                key = os.path.relpath(os.path.join(base, name), root)
                if key.startswith(prefix):
                    out.append({"key": key, "size": os.path.getsize(os.path.join(base, name))})
        return out


def _script(args, messages) -> dict:
    """What the scripted model answers, decided from what it is sent. Every
    call is a billed vendor call: it is logged before anything else."""
    import uuid

    from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage

    system = " ".join(str(m.content) for m in messages if isinstance(m, SystemMessage))
    tool_results = [str(m.content) for m in messages if isinstance(m, ToolMessage)]
    humans = [str(m.content) for m in messages if isinstance(m, HumanMessage)]
    scope = "child" if "You are a subagent" in system else "root"
    n = len(tool_results)

    def call(name, call_args):
        return {"name": name, "args": call_args, "id": "toolu_" + uuid.uuid4().hex[:12]}

    def fake_tool_call(round_no):
        return call("fake_tool", {"round": round_no, "scope": scope, "note": ARG_MARKER})

    plan = {"text": "", "calls": [], "crash_after_chunks": None, "crash_now": False}
    v = args.variant
    if v == "request":
        plan["text"] = "A short title"
    elif v in ("main", "divergence", "late_crash"):
        if n < 2:
            plan["calls"] = [fake_tool_call(n + 1)]
        else:
            plan["text"] = FINAL_ANSWER
    elif v == "stream":
        if n == 0:
            plan["text"], plan["calls"] = "Let me check.", [fake_tool_call(1)]
        else:
            plan["text"] = STREAM_ANSWER
            plan["crash_after_chunks"] = 3 if args.phase == "start" else None
    elif v == "hitl":
        choice = humans[-1].rsplit("chose:", 1)[-1].strip() if humans else ""
        plan["text"] = f"You chose {choice}."
        plan["crash_now"] = args.phase == "start"
    elif v == "subagent":
        if scope == "child":
            if n < 2:
                plan["calls"] = [fake_tool_call(n + 1)]
            else:
                plan["text"] = "Child report: the delegated work is done."
        elif n == 0:
            plan["calls"] = [call("spawn_agent", {"prompt": "Do the delegated work.", "agent_type": "worker"})]
        else:
            plan["text"] = FINAL_ANSWER
    from dbos import DBOS

    append_line(args.dir, "llm_bodies.log", {
        "pid": os.getpid(), "phase": args.phase, "scope": scope, "n_tool_results": n,
        "tool_results": tool_results, "last_human": humans[-1] if humans else "",
        "minted": [c["id"] for c in plan["calls"]], "workflow_id": DBOS.workflow_id,
    })
    return plan


def _make_model(args):
    from langchain_core.language_models.chat_models import BaseChatModel, generate_from_stream
    from langchain_core.messages import AIMessageChunk
    from langchain_core.outputs import ChatGenerationChunk

    class ScriptedChatModel(BaseChatModel):
        @property
        def _llm_type(self) -> str:
            return "harness-scripted"

        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            raise NotImplementedError("the harness model is async-only")

        async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
            chunks = [c async for c in self._astream(messages, stop=stop, **kwargs)]
            return generate_from_stream(iter(chunks))

        async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
            plan = _script(args, messages)
            if plan["crash_now"]:
                os._exit(137)
            words = [w + " " for w in plan["text"].split(" ")] if plan["text"] else []
            if words:
                words[-1] = words[-1].rstrip()
            for i, word in enumerate(words, start=1):
                yield ChatGenerationChunk(message=AIMessageChunk(content=word))
                if plan["crash_after_chunks"] and i == plan["crash_after_chunks"]:
                    await asyncio.sleep(0.8)  # let the run publish what streamed
                    os._exit(137)
            yield ChatGenerationChunk(message=AIMessageChunk(
                content="",
                tool_call_chunks=[
                    {"name": c["name"], "args": json.dumps(c["args"]), "id": c["id"], "index": i,
                     "type": "tool_call_chunk"}
                    for i, c in enumerate(plan["calls"])
                ],
                usage_metadata={"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
            ))

    return ScriptedChatModel()


def _make_fake_tool(args):
    from graph_tools.base import GraphTool, ToolResult

    def crashes(scope: str, round_no: int) -> bool:
        if args.phase != "start" or round_no != 2:
            return False
        return (args.variant in ("main", "divergence") and scope == "root") or \
            (args.variant == "subagent" and scope == "child")

    class FakeTool(GraphTool):
        name = "fake_tool"
        description = "Harness tool: stores one file and reports the round."
        parameters = {"type": "object", "properties": {"round": {"type": "integer"}}}
        credential_ref = None

        async def run(self, call_args, context):
            round_no, scope = int(call_args.get("round") or 0), call_args.get("scope") or "root"
            append_line(args.dir, "tool_effects.log", {
                "pid": os.getpid(), "phase": args.phase, "round": round_no, "scope": scope,
                "seed": context.artifact_seed,
            })
            artifact = context.save_artifact(b"%PDF-1.4 harness", "application/pdf", f"{scope}-{round_no}.pdf")
            if crashes(scope, round_no):
                await asyncio.sleep(0.3)
                os._exit(137)
            return ToolResult(content=f"{scope} round {round_no} done", artifacts=[artifact])

    return FakeTool()


async def _setup_replay_runtime(args):
    """Install the fakes and the SQLite-backed tables; returns the checkpointer."""
    import durable_runtime
    import runs
    import tool_ledger
    import graph.nodes.llm_node as llm_node
    import graph.nodes.tool_executor as tool_executor
    from graph.tools_runtime import get_registry
    from graph_tools.base import ToolContext

    pool = await setup_app_db(args.dir)
    await tool_ledger.setup(pool)
    saver = _make_file_saver(os.path.join(args.dir, "checkpoints.pkl"))
    durable_runtime._checkpointer = saver

    record, nodes = _graph_records(args.variant)
    runs.get_graph_and_nodes_by_id = lambda graph_id: (record, nodes) if graph_id == GRAPH_ID else None

    model = _make_model(args)
    llm_node._build_llm_and_structured = lambda *a, **k: (model, None)
    llm_node.resolve_credentials = lambda customer_id, provider: {}

    get_registry().register(_make_fake_tool(args))

    def make_tool_context(customer_id, secrets=None):
        context = ToolContext(
            customer_id=customer_id, store=FileStore(args.dir),
            key_template="customers/{customer_id}/attachments/{artifact_id}",
        )
        if secrets is not None:
            context.secrets = secrets
        return context

    tool_executor.make_tool_context = make_tool_context
    return saver


async def _wait_for_row(predicate, timeout: float = 30.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for row in await run_event_rows():
            if predicate(row["event"]):
                return row
        await asyncio.sleep(0.2)
    return None


async def _purge_report(saver, graph, cfg) -> dict:
    """DELETE /runs/{id}/data twice over the finished run (plan 3.9), then
    what is left of it in each store."""
    import durable_runtime
    import tool_ledger
    from dbos import DBOS
    from routes import runs as runs_routes

    durable_runtime._ready = True
    codes = [(await runs_routes.delete_run_data(RUN_ID)).status_code for _ in range(2)]
    try:
        steps_left = len(await DBOS.list_workflow_steps_async(RUN_ID))
    except Exception as e:  # an unknown workflow may raise rather than list nothing
        steps_left = type(e).__name__
    return {
        "codes": codes,
        "status_after": _status_dict(await DBOS.get_workflow_status_async(RUN_ID))["status"],
        "steps_after": steps_left,
        "threads_after": _threads_with_checkpoints(saver),
        "checkpoint_after": bool((await graph.aget_state(cfg)).values),
        "rows_after": len(await run_event_rows()),
        "ledger_after": len(await tool_ledger.attempts(RUN_ID)),
    }


def _threads_with_checkpoints(saver) -> list[str]:
    # InMemorySaver's storage is a defaultdict: a read leaves an empty entry.
    return [thread for thread, namespaces in saver.storage.items() if any(namespaces.values())]


def scenario_request_agent(args) -> None:
    """execute_agent_graph with durable=true (plan 3.9): the request agent runs
    as request_agent_run under workflow id = run id, and its DBOS rows and
    checkpoints are gone once the route returns."""
    import durable_runtime
    import runs
    import graph.nodes.llm_node as llm_node
    from dbos import DBOS
    from models import ExecuteAgentGraphRequest
    from routes import retrieve as retrieve_routes

    record = {"graphId": "title-agent", "customerId": "System", "entryPoint": "gen", "latestVersion": 1,
              "edges": json.dumps({"edges": [{"from": "gen", "to": "__end__"}]})}
    nodes = [{"nodeId": "gen", "nodeType": "GENERATION", "name": "Title",
              "config": json.dumps({"system_prompt": "Write a title.", "input_template": "{original_query}"})}]
    retrieve_routes.get_graph_and_nodes_by_id = lambda graph_id: (record, nodes)
    runs.get_graph_and_nodes_by_id = lambda graph_id: (record, nodes)
    model = _make_model(args)
    llm_node._build_llm_and_structured = lambda *a, **k: (model, None)
    llm_node.resolve_credentials = lambda customer_id, provider: {}

    async def main():
        saver = _make_file_saver(os.path.join(args.dir, "checkpoints.pkl"))
        durable_runtime._checkpointer = saver
        DBOS.launch()
        durable_runtime._ready = True
        req = ExecuteAgentGraphRequest(
            graph_id="title-agent", customer_id=CUSTOMER_ID, llm_credentials={}, llm_provider="anthropic",
            durable=True, variables={"original_query": "Plan a trip to Lisbon"},
        )
        response = await retrieve_routes.execute_agent_graph(req)
        remaining = await DBOS.list_workflows_async(name="request_agent_run", load_input=False, load_output=False)
        emit_result({
            "status_code": response.status_code,
            "body": json.loads(response.body),
            "remaining": [w.workflow_id for w in remaining],
            "threads_after": _threads_with_checkpoints(saver),
        })
        DBOS.destroy()

    asyncio.run(main())


def scenario_replay(args) -> None:
    import durable_metrics
    import run_events
    import runs
    import tool_ledger
    import graph.nodes.tool_executor as tool_executor
    from dbos import DBOS

    if args.variant == "late_crash" and args.phase == "start":
        original_publish = run_events.publish

        async def publish_then_die_at_usage(run_id, event, terminal=False):
            if "usage" in event:  # the graph has finished; the run has not
                os._exit(137)
            return await original_publish(run_id, event, terminal)

        run_events.publish = publish_then_die_at_usage

    if args.variant == "divergence" and args.phase == "recover":
        # This build records tool steps under another name: the replay reaches
        # a recorded tool_invoke step and must fail, not carry on.
        @DBOS.step(name="tool_invoke_renamed")
        async def renamed_tool_step(tool, call, context):
            return await tool_executor._invoke_with_ledger(tool, call, context, DBOS.workflow_id, DBOS.step_id)

        tool_executor._durable_tool_invoke = renamed_tool_step

    async def main():
        saver = await _setup_replay_runtime(args)
        DBOS.launch()
        await runs.register_run_queue()
        if args.phase == "start":
            await runs.enqueue_run(RUN_ID, {**RUN_INPUT, "graph_id": GRAPH_ID})
            if args.variant == "hitl":
                # POST /runs/{id}/resume, once the run asks for input.
                if await _wait_for_row(lambda ev: "awaiting_input" in ev):
                    await DBOS.send_async(RUN_ID, HITL_VALUE, topic="resume")
        st = await wait_for_status(RUN_ID, _TERMINAL, timeout=60)

        steps = await DBOS.list_workflow_steps_async(RUN_ID)
        summary = await DBOS.get_result_async(RUN_ID) if st is not None and st.status == "SUCCESS" else None
        graph = runs._resolve_durable_graph(CUSTOMER_ID, GRAPH_ID, saver)[0]
        cfg = {"configurable": {"thread_id": RUN_ID}}
        snap = await graph.aget_state(cfg)
        loop_messages = (snap.values or {}).get("loop_messages") or []
        result = {
            **_status_dict(st),
            "steps": [[s["function_id"], s["function_name"]] for s in steps],
            "summary": summary,
            "history": [m.get("tool_call_id") for m in loop_messages if m.get("role") == "tool"],
            "history_calls": [c.get("id") for m in loop_messages if m.get("role") == "assistant"
                              for c in m.get("tool_calls") or []],
            "rows": await run_event_rows(),
            "ledger": [{k: (v if isinstance(v, (int, type(None))) else str(v)) for k, v in row.items()}
                       for row in await tool_ledger.attempts(RUN_ID)],
            "recovered_metric": durable_metrics.DURABLE_RUN_RECOVERED._value.get(),
            "interrupted_metric": durable_metrics.TOOL_CALL_INTERRUPTED.labels(tool="fake_tool")._value.get(),
        }
        if args.variant == "main" and st is not None and st.status == "SUCCESS":
            result["purge"] = await _purge_report(saver, graph, cfg)
        emit_result(result)
        DBOS.destroy()

    asyncio.run(main())


SCENARIOS = {
    "poison": scenario_poison,
    "poison_request": scenario_poison_request,
    "cancel": scenario_cancel,
    "stranded": scenario_stranded,
    "replay": scenario_replay,
    "request_agent": scenario_request_agent,
}


def main(argv=None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("scenario", choices=sorted(SCENARIOS))
    parser.add_argument("--dir", required=True)
    parser.add_argument("--phase", choices=["start", "recover"], default="start")
    parser.add_argument("--variant", default="main")
    args = parser.parse_args(argv)
    # Must be set before durable_runtime is imported: it constructs the DBOS
    # singleton at import, from DATABASE_URL.
    os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(args.dir, "dbos.sqlite")
    sys.path.insert(0, os.getcwd())
    SCENARIOS[args.scenario](args)


if __name__ == "__main__":
    main()
