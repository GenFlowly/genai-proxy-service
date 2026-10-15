"""
Unit tests for the run sweep (durable_runtime.sweep_once) and
run_events.publish_terminal_once — plan 0.2.

run_events runs its real SQL on an SQLite file (tests/sqlite_pool.py); DBOS is
a fake that answers list_workflows_async from a fixed set of workflows, so each
target of the sweep is pinned without crashing processes (the integration
tests in test_durable_recovery_cap.py do that against real DBOS).

Run with `python -m unittest tests.test_durable_sweep`.
"""
import os
import tempfile
import unittest
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import durable_metrics
import durable_runtime
import psycopg.errors
import run_events
import runs
from tests.sqlite_pool import SqlitePool

NOW_MS = int(datetime.now().timestamp() * 1000)


def _wf(workflow_id, name="agent_run", status="MAX_RECOVERY_ATTEMPTS_EXCEEDED", app_version="v2",
        created_ms=None, updated_ms=None, recovery_attempts=5):
    created = NOW_MS - 60_000 if created_ms is None else created_ms
    updated = created if updated_ms is None else updated_ms
    return SimpleNamespace(
        workflow_id=workflow_id, name=name, status=status, app_version=app_version,
        created_at=created, updated_at=updated,
        completed_at=updated if status not in ("PENDING", "ENQUEUED") else None,
        recovery_attempts=recovery_attempts, executor_id="local", input={"args": ("secret",)},
    )


def _ms(iso: str) -> int:
    return int(datetime.fromisoformat(iso).timestamp() * 1000)


class FakeDBOS:
    """The slice of the DBOS API the sweep uses, over an in-memory list."""

    application_version = "v2"

    def __init__(self, workflows):
        self.workflows = list(workflows)
        self.cancelled: list[str] = []
        self.list_calls: list[dict] = []

    async def list_workflows_async(self, *, name=None, status=None, start_time=None, end_time=None,
                                   completed_after=None, limit=None, sort_desc=False,
                                   load_input=True, load_output=True):
        self.list_calls.append({"name": name, "status": status, "load_input": load_input})
        statuses = [status] if isinstance(status, str) else status
        out = []
        for w in self.workflows:
            if name is not None and w.name != name:
                continue
            if statuses is not None and w.status not in statuses:
                continue
            if start_time and w.created_at < _ms(start_time):
                continue
            if end_time and w.created_at > _ms(end_time):
                continue
            if completed_after and (w.completed_at is None or w.completed_at < _ms(completed_after)):
                continue
            out.append(w)
        return out[:limit] if limit else out

    async def cancel_workflow_async(self, workflow_id):
        self.cancelled.append(workflow_id)
        for w in self.workflows:
            if w.workflow_id == workflow_id:
                w.status = "CANCELLED"


def _metric(workflow: str) -> float:
    return durable_metrics.DURABLE_RUN_DEAD_LETTERED.labels(workflow=workflow)._value.get()


class _EventsDB(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.pool = SqlitePool(os.path.join(self._dir.name, "events.sqlite"))
        self._saved_pool = run_events._pool
        await run_events.setup(self.pool)

    async def asyncTearDown(self):
        run_events._pool = self._saved_pool
        self._dir.cleanup()

    async def rows(self, run_id):
        return [(r["event"], bool(r["terminal"])) for r in await run_events.read_since(run_id, 0)]


class PublishTerminalOnceTest(_EventsDB):
    async def test_writes_the_error_row_then_the_terminal_row(self):
        events = run_events.failure_events("run_1", "lost", "run_lost")
        self.assertTrue(await run_events.publish_terminal_once("run_1", events))
        self.assertEqual(await self.rows("run_1"), [
            ({"error": "lost", "error_type": "run_lost"}, False),
            ({"status": "error", "run_id": "run_1", "error": "lost", "error_type": "run_lost"}, True),
        ])

    async def test_a_second_call_adds_nothing(self):
        events = run_events.failure_events("run_1", "lost", "run_lost")
        await run_events.publish_terminal_once("run_1", events)
        self.assertFalse(await run_events.publish_terminal_once("run_1", events))
        self.assertEqual(len(await self.rows("run_1")), 2)

    async def test_appends_after_the_runs_own_rows(self):
        await run_events.publish("run_1", {"content": "partial"})
        await run_events.publish_terminal_once("run_1", run_events.failure_events("run_1", "x", "error"))
        seqs = [r["seq"] for r in await run_events.read_since("run_1", 0)]
        self.assertEqual(seqs, [1, 2, 3])

    async def test_a_run_that_ended_itself_is_left_alone(self):
        await run_events.publish("run_1", {"status": "completed"}, terminal=True)
        self.assertFalse(await run_events.publish_terminal_once(
            "run_1", run_events.failure_events("run_1", "x", "error")))
        self.assertEqual(await self.rows("run_1"), [({"status": "completed"}, True)])

    async def test_a_primary_key_conflict_counts_as_done(self):
        class _ConflictingConn:
            async def execute(self, *a, **k):
                raise psycopg.errors.UniqueViolation("duplicate key value violates unique constraint")

            def transaction(self):
                return _Noop()

        class _Noop:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

        class _Pool:
            def connection(self):
                return _Ctx()

        class _Ctx:
            async def __aenter__(self):
                return _ConflictingConn()

            async def __aexit__(self, *exc):
                return False

        run_events._pool = _Pool()
        self.assertFalse(await run_events.publish_terminal_once(
            "run_1", run_events.failure_events("run_1", "x", "error")))

    async def test_runs_are_independent(self):
        await run_events.publish_terminal_once("run_1", run_events.failure_events("run_1", "x", "error"))
        self.assertTrue(await run_events.publish_terminal_once(
            "run_2", run_events.failure_events("run_2", "x", "error")))


class SweepTest(_EventsDB):
    async def test_dead_lettered_agent_run_gets_one_error_and_one_terminal_row(self):
        dbos = FakeDBOS([_wf("run_dead")])
        before = _metric("agent_run")
        state = durable_runtime.SweepState()
        await durable_runtime.sweep_once(state, dbos)
        await durable_runtime.sweep_once(state, dbos)
        await durable_runtime.sweep_once(durable_runtime.SweepState(), dbos)  # after a restart

        rows = await self.rows("run_dead")
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0], ({"error": run_events.RUN_LOST_MESSAGE, "error_type": "run_lost"}, False))
        self.assertTrue(rows[1][1])
        self.assertEqual(rows[1][0]["status"], "error")
        self.assertEqual(_metric("agent_run") - before, 1)

    async def test_failed_agent_run_ends_with_a_generic_error_and_is_not_a_dead_letter(self):
        dbos = FakeDBOS([_wf("run_err", status="ERROR")])
        before = _metric("agent_run")
        await durable_runtime.sweep_once(durable_runtime.SweepState(), dbos)
        rows = await self.rows("run_err")
        self.assertEqual(rows[0], ({"error": run_events.RUN_FAILED_MESSAGE, "error_type": "error"}, False))
        self.assertEqual(rows[1][0]["error_type"], "error")
        self.assertEqual(_metric("agent_run"), before)

    async def test_runs_older_than_the_event_ttl_are_ignored(self):
        old = NOW_MS - (durable_runtime.RUN_EVENTS_TTL_SEC + 3600) * 1000
        dbos = FakeDBOS([_wf("run_old", created_ms=old)])
        await durable_runtime.sweep_once(durable_runtime.SweepState(), dbos)
        self.assertEqual(await self.rows("run_old"), [])

    async def test_a_run_that_completed_normally_is_untouched(self):
        dbos = FakeDBOS([_wf("run_ok", status="SUCCESS"), _wf("run_cancelled", status="CANCELLED")])
        await durable_runtime.sweep_once(durable_runtime.SweepState(), dbos)
        self.assertEqual(await self.rows("run_ok"), [])
        self.assertEqual(await self.rows("run_cancelled"), [])

    async def test_stranded_old_version_run_is_cancelled_and_ended(self):
        eleven_min_ago = NOW_MS - 11 * 60_000
        dbos = FakeDBOS([
            _wf("run_stranded", status="PENDING", app_version="v1", created_ms=eleven_min_ago),
            _wf("run_queued", status="ENQUEUED", app_version="v1", created_ms=eleven_min_ago),
            _wf("run_current", status="PENDING", app_version="v2", created_ms=eleven_min_ago),
            _wf("run_unversioned", status="ENQUEUED", app_version=None, created_ms=eleven_min_ago),
            _wf("run_young", status="PENDING", app_version="v1", created_ms=NOW_MS - 60_000),
        ])
        await durable_runtime.sweep_once(durable_runtime.SweepState(), dbos)

        self.assertEqual(sorted(dbos.cancelled), ["run_queued", "run_stranded"])
        for run_id in ("run_stranded", "run_queued"):
            rows = await self.rows(run_id)
            self.assertEqual([r[0]["error_type"] for r in rows], ["run_lost", "run_lost"])
            self.assertEqual([r[1] for r in rows], [False, True])
        for run_id in ("run_current", "run_unversioned", "run_young"):
            self.assertEqual(await self.rows(run_id), [])

    async def test_request_agent_dead_letters_are_counted_once(self):
        state = durable_runtime.SweepState()
        dbos = FakeDBOS([_wf("ra-1", name="request_agent_run", updated_ms=NOW_MS - 1000)])
        before = _metric("request_agent_run")
        with self.assertLogs("durable_runtime", level="WARNING") as logs:
            await durable_runtime.sweep_once(state, dbos)
            await durable_runtime.sweep_once(state, dbos)
        self.assertEqual(_metric("request_agent_run") - before, 1)
        self.assertEqual(sum("ra-1" in line for line in logs.output), 1)
        # A dead letter newer than the previous pass is counted on the next one.
        dbos.workflows.append(_wf("ra-2", name="request_agent_run", updated_ms=NOW_MS + 5000))
        await durable_runtime.sweep_once(state, dbos)
        self.assertEqual(_metric("request_agent_run") - before, 2)
        # Request agents get no run_events rows: their caller is gone.
        self.assertEqual(await self.rows("ra-1"), [])

    async def test_dead_letters_from_before_this_process_are_not_recounted(self):
        state = durable_runtime.SweepState(started_ms=NOW_MS)
        dbos = FakeDBOS([_wf("ra-old", name="request_agent_run", updated_ms=NOW_MS - 3_600_000)])
        before = _metric("request_agent_run")
        await durable_runtime.sweep_once(state, dbos)
        self.assertEqual(_metric("request_agent_run"), before)

    async def test_logs_ids_and_never_inputs(self):
        dbos = FakeDBOS([_wf("run_dead")])
        with self.assertLogs("durable_runtime", level="WARNING") as logs:
            await durable_runtime.sweep_once(durable_runtime.SweepState(), dbos)
        text = "\n".join(logs.output)
        self.assertIn("run_dead", text)
        self.assertIn("recovery_attempts=5", text)
        self.assertNotIn("secret", text)
        # Inputs are loaded only to find old request runs' thread ids.
        self.assertEqual([c["name"] for c in dbos.list_calls if c["load_input"]], ["request_agent_run"])

    async def test_request_runs_older_than_an_hour_are_deleted(self):
        two_hours_ago = NOW_MS - 2 * 3600 * 1000
        old_legacy = _wf("8f1c-uuid", name="request_agent_run", status="MAX_RECOVERY_ATTEMPTS_EXCEEDED",
                         created_ms=two_hours_ago)
        old_legacy.input = {"args": ("ra-legacy", {"variables": {"q": "conversation text"}}), "kwargs": {}}
        old_current = _wf("ra-new-style", name="request_agent_run", status="PENDING", created_ms=two_hours_ago)
        old_current.input = {"args": ("ra-new-style", {}), "kwargs": {}}
        young = _wf("ra-young", name="request_agent_run", status="SUCCESS")
        agent = _wf("run_old_agent", name="agent_run", status="SUCCESS", created_ms=two_hours_ago)
        dbos = FakeDBOS([old_legacy, old_current, young, agent])
        with patch.object(runs, "delete_request_run", AsyncMock()) as delete:
            with self.assertLogs("durable_runtime", level="WARNING") as logs:
                await durable_runtime.sweep_once(durable_runtime.SweepState(), dbos)
        self.assertEqual(sorted(c.args for c in delete.await_args_list),
                         [("8f1c-uuid", "ra-legacy"), ("ra-new-style", "ra-new-style")])
        self.assertNotIn("conversation text", "\n".join(logs.output))

    async def test_a_failing_part_does_not_stop_the_others(self):
        dbos = FakeDBOS([_wf("run_dead")])
        original = dbos.list_workflows_async

        async def flaky(**kwargs):
            if kwargs.get("status") == ["PENDING", "ENQUEUED"]:
                raise RuntimeError("database unavailable")
            return await original(**kwargs)

        dbos.list_workflows_async = flaky
        with self.assertLogs("durable_runtime", level="ERROR"):
            await durable_runtime.sweep_once(durable_runtime.SweepState(), dbos)
        self.assertEqual(len(await self.rows("run_dead")), 2)


class SweepLoopTest(unittest.IsolatedAsyncioTestCase):
    async def test_first_pass_after_the_delay_then_every_interval(self):
        sleeps: list[float] = []
        passes: list[int] = []

        async def fake_sleep(seconds):
            sleeps.append(seconds)
            if len(sleeps) > 3:
                raise __import__("asyncio").CancelledError()

        async def fake_sweep(state, dbos=None):
            passes.append(len(sleeps))

        with patch("asyncio.sleep", fake_sleep), patch.object(durable_runtime, "sweep_once", fake_sweep):
            await durable_runtime._sweep_loop()
        self.assertEqual(sleeps[0], durable_runtime.SWEEP_FIRST_DELAY_SEC)
        self.assertEqual(sleeps[1:], [durable_runtime.SWEEP_INTERVAL_SEC] * 3)
        self.assertEqual(passes, [1, 2, 3])


if __name__ == "__main__":
    unittest.main()
