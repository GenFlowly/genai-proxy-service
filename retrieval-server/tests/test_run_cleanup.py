"""
Unit tests for durable-run cleanup (run_cleanup) and DBOS idle-polling tuning
(durable_runtime) — no live DB, no launched DBOS.

Covers: checkpoints dropped when a workflow ends but kept when its task is
cancelled for recovery, the sweep deleting ended runs then orphans, unused
queue deletion, the DBOS internals _quiet_idle_polling sets still existing
on the pinned version, and startup giving up promptly on an unreachable
database. Run with:
    .venv/bin/python -m unittest tests.test_run_cleanup
"""
import asyncio
import unittest
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

from dbos import DBOS
from dbos._error import DBOSWorkflowCancelledError

import durable_runtime
import run_cleanup


class _FakeCursor:
    def __init__(self, rowcount):
        self.rowcount = rowcount


class _FakeConn:
    def __init__(self):
        self.sql = []

    async def execute(self, sql, params=None):
        self.sql.append(sql)
        return _FakeCursor(2)


class _FakePool:
    def __init__(self):
        self.conn = _FakeConn()

    def connection(self):
        pool = self

        class _Ctx:
            async def __aenter__(self):
                return pool.conn

            async def __aexit__(self, *exc):
                return False

        return _Ctx()


class CheckpointsDroppedAtEndTest(unittest.IsolatedAsyncioTestCase):
    async def _run(self, body_error=None):
        delete = AsyncMock()
        with patch.object(run_cleanup, "delete_checkpoints", delete):
            try:
                async with run_cleanup.checkpoints_dropped_at_end("run_1"):
                    if body_error is not None:
                        raise body_error
            except BaseException as e:
                return delete, e
        return delete, None

    async def test_deleted_when_the_body_returns(self):
        delete, error = await self._run()
        self.assertIsNone(error)
        delete.assert_awaited_once_with("run_1")

    async def test_deleted_and_reraised_when_the_body_fails(self):
        delete, error = await self._run(RuntimeError("model not found"))
        self.assertIsInstance(error, RuntimeError)
        delete.assert_awaited_once_with("run_1")

    async def test_deleted_when_the_run_is_cancelled(self):
        delete, error = await self._run(DBOSWorkflowCancelledError("cancelled"))
        self.assertIsInstance(error, DBOSWorkflowCancelledError)
        delete.assert_awaited_once_with("run_1")

    async def test_kept_when_the_task_is_cancelled_for_recovery(self):
        delete, error = await self._run(asyncio.CancelledError())
        self.assertIsInstance(error, asyncio.CancelledError)
        delete.assert_not_awaited()


class DeleteCheckpointsTest(unittest.IsolatedAsyncioTestCase):
    async def test_deletes_the_run_thread(self):
        saver = MagicMock(adelete_thread=AsyncMock())
        with patch.object(durable_runtime, "get_checkpointer", return_value=saver):
            await run_cleanup.delete_checkpoints("run_1")
        saver.adelete_thread.assert_awaited_once_with("run_1")

    async def test_a_failed_delete_never_raises(self):
        saver = MagicMock(adelete_thread=AsyncMock(side_effect=OSError("connection lost")))
        with patch.object(durable_runtime, "get_checkpointer", return_value=saver), \
             self.assertLogs(run_cleanup.logger, level="ERROR"):
            await run_cleanup.delete_checkpoints("run_1")

    async def test_no_checkpointer_is_a_no_op(self):
        with patch.object(durable_runtime, "get_checkpointer", return_value=None):
            await run_cleanup.delete_checkpoints("run_1")


class SweepTest(unittest.IsolatedAsyncioTestCase):
    async def test_deletes_ended_runs_in_batches_then_orphans(self):
        full = [MagicMock(workflow_id=f"run_{i}") for i in range(run_cleanup._BATCH)]
        rest = [MagicMock(workflow_id="ra-last")]
        listing = AsyncMock(side_effect=[full, rest])
        delete = AsyncMock()
        pool = _FakePool()
        with patch.object(DBOS, "list_workflows_async", listing), \
             patch.object(DBOS, "delete_workflows_async", delete), \
             patch.object(durable_runtime, "get_pool", return_value=pool):
            await run_cleanup.sweep(3600)

        self.assertEqual(listing.await_count, 2)
        kwargs = listing.await_args.kwargs
        self.assertEqual(set(kwargs["status"]), {"SUCCESS", "ERROR", "CANCELLED", "MAX_RECOVERY_ATTEMPTS_EXCEEDED"})
        cutoff = datetime.fromisoformat(kwargs["completed_before"])
        age = (datetime.now(timezone.utc) - cutoff).total_seconds()
        self.assertAlmostEqual(age, 3600, delta=5)
        self.assertFalse(kwargs["load_input"])
        self.assertFalse(kwargs["load_output"])

        self.assertEqual(delete.await_args_list[0].args[0], [w.workflow_id for w in full])
        self.assertEqual(delete.await_args_list[1].args[0], ["ra-last"])

        deleted_from = [sql.split()[2] for sql in pool.conn.sql]
        self.assertEqual(deleted_from, ["checkpoint_writes", "checkpoint_blobs", "checkpoints", "run_events"])
        for sql in pool.conn.sql:
            self.assertIn(f"{durable_runtime.DBOS_SYSTEM_SCHEMA}.workflow_status", sql)

    async def test_nothing_ended_still_clears_orphans(self):
        delete = AsyncMock()
        pool = _FakePool()
        with patch.object(DBOS, "list_workflows_async", AsyncMock(return_value=[])), \
             patch.object(DBOS, "delete_workflows_async", delete), \
             patch.object(durable_runtime, "get_pool", return_value=pool):
            await run_cleanup.sweep(3600)

        delete.assert_not_awaited()
        self.assertEqual(len(pool.conn.sql), 4)


class DeleteUnusedQueuesTest(unittest.IsolatedAsyncioTestCase):
    async def test_deletes_every_queue_and_clears_the_list_cache(self):
        queues = [MagicMock(), MagicMock()]
        queues[0].name, queues[1].name = "agent_runs", "p2_node_q"
        delete = AsyncMock()
        durable_runtime._queue_list_cache["stale"] = (0.0, queues)
        with patch.object(DBOS, "list_queues_async", AsyncMock(return_value=queues)), \
             patch.object(DBOS, "delete_queue_async", delete):
            await durable_runtime._delete_unused_queues()

        self.assertEqual([c.args[0] for c in delete.await_args_list], ["agent_runs", "p2_node_q"])
        self.assertEqual(durable_runtime._queue_list_cache, {})


class QuietIdlePollingTest(unittest.TestCase):
    def setUp(self):
        from dbos import _workflow_commands
        from dbos._dbos import _get_or_create_dbos_registry
        from dbos._sys_db import SystemDatabase

        self.commands = _workflow_commands
        self.internal_queue = _get_or_create_dbos_registry().get_internal_queue()
        self.system_db = SystemDatabase
        saved = (_workflow_commands._BACKGROUND_JOBS_INTERVAL_SEC,
                 self.internal_queue._polling_interval_sec, SystemDatabase.list_queues)

        def restore():
            (_workflow_commands._BACKGROUND_JOBS_INTERVAL_SEC,
             self.internal_queue._polling_interval_sec, SystemDatabase.list_queues) = saved
            durable_runtime._queue_list_cache.clear()

        self.addCleanup(restore)
        self.list_queues = MagicMock(return_value=["q"])
        SystemDatabase.list_queues = self.list_queues

    def test_slows_the_one_second_loops_on_the_pinned_version(self):
        durable_runtime._quiet_idle_polling()

        self.assertEqual(self.commands._BACKGROUND_JOBS_INTERVAL_SEC, durable_runtime._BACKGROUND_JOBS_SEC)
        self.assertEqual(self.internal_queue._polling_interval_sec, durable_runtime._INTERNAL_QUEUE_POLL_SEC)

        sys_db = object()
        first = self.system_db.list_queues(sys_db, application_name="retrieval-server")
        second = self.system_db.list_queues(sys_db, application_name="retrieval-server")
        self.assertEqual(first, ["q"])
        self.assertIs(second, first)
        self.list_queues.assert_called_once_with(sys_db, application_name="retrieval-server")

    def test_other_versions_keep_dbos_defaults(self):
        before = self.commands._BACKGROUND_JOBS_INTERVAL_SEC
        with patch("importlib.metadata.version", return_value="9.9.9"), \
             self.assertLogs(durable_runtime.logger, level="WARNING"):
            durable_runtime._quiet_idle_polling()

        self.assertEqual(self.commands._BACKGROUND_JOBS_INTERVAL_SEC, before)
        self.assertIs(self.system_db.list_queues, self.list_queues)



class StartupUnreachableDatabaseTest(unittest.IsolatedAsyncioTestCase):
    async def test_gives_up_within_the_connect_timeout_and_closes_the_pool(self):
        unreachable = "postgresql://user:pw@127.0.0.1:1/postgres?connect_timeout=1"
        with patch.object(durable_runtime, "_dbos_constructed", True), \
             patch.object(durable_runtime, "DATABASE_URL", unreachable), \
             patch.object(durable_runtime, "_CONNECT_TIMEOUT_SEC", 1.0), \
             patch.object(DBOS, "launch") as launch, \
             self.assertLogs(durable_runtime.logger, level="ERROR"):
            started = asyncio.get_running_loop().time()
            await durable_runtime.startup()
            elapsed = asyncio.get_running_loop().time() - started

        self.assertLess(elapsed, 5)
        self.assertFalse(durable_runtime.is_ready())
        self.assertIsNone(durable_runtime.get_pool())
        self.assertIsNone(durable_runtime.get_checkpointer())
        launch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
