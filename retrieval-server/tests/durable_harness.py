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


SCENARIOS = {
    "poison": scenario_poison,
    "poison_request": scenario_poison_request,
    "cancel": scenario_cancel,
    "stranded": scenario_stranded,
}


def main(argv=None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("scenario", choices=sorted(SCENARIOS))
    parser.add_argument("--dir", required=True)
    parser.add_argument("--phase", choices=["start", "recover"], default="start")
    args = parser.parse_args(argv)
    # Must be set before durable_runtime is imported: it constructs the DBOS
    # singleton at import, from DATABASE_URL.
    os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(args.dir, "dbos.sqlite")
    sys.path.insert(0, os.getcwd())
    SCENARIOS[args.scenario](args)


if __name__ == "__main__":
    main()
