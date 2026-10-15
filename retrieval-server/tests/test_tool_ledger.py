"""
Unit tests for the tool-call attempt ledger (tool_ledger.py, plan 0.4) and the
tool_invoke step body built on it (tool_executor._invoke_with_ledger).

The ledger's real SQL runs on SQLite (tests/sqlite_pool.py). Pinned here:
every begin() rule, finish/prune/purge, rows that carry no arguments, the
deterministic artifact ids of a seeded call, and that a replay divergence
escapes the tool executor instead of becoming a tool error.

Run with `python -m unittest tests.test_tool_ledger`.
"""
import dataclasses
import os
import pickle
import tempfile
import unittest
import uuid
from datetime import timedelta
from unittest.mock import patch

import psycopg.errors

import durable_metrics
import tool_ledger
from graph.nodes import tool_executor as tool_executor_module
from graph_tools import base as graph_tools_base
from graph_tools.base import GraphTool, ToolContext, ToolResult
from tests.sqlite_pool import SqlitePool


class _MemoryStore:
    def __init__(self):
        self.objects: dict[str, bytes] = {}

    def put(self, key, data, content_type, **kwargs):
        self.objects[key] = data

    def get(self, key):
        return self.objects[key]

    def list(self, prefix):
        return [{"key": k} for k in self.objects if k.startswith(prefix)]


class _LedgerDB(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self._saved_pool = tool_ledger._pool
        await tool_ledger.setup(SqlitePool(os.path.join(self._dir.name, "ledger.sqlite")))

    async def asyncTearDown(self):
        tool_ledger._pool = self._saved_pool
        self._dir.cleanup()

    async def rows(self, workflow_id="wf-1"):
        return await tool_ledger.attempts(workflow_id)


class BeginRulesTest(_LedgerDB):
    async def test_no_earlier_attempt_records_attempt_1_and_runs(self):
        attempt = await tool_ledger.begin("wf-1", 3, "toolu_a", "generate_pdf", "cust-1")
        self.assertEqual(attempt, tool_ledger.Attempt(attempt=1, run=True))
        [row] = await self.rows()
        self.assertEqual((row["function_id"], row["attempt"], row["status"]), (3, 1, "started"))
        self.assertEqual(row["owner_boot_id"], tool_ledger.BOOT_ID)
        self.assertIsNone(row["finished_at"])

    async def test_an_interrupted_attempt_is_not_run_again(self):
        await tool_ledger.begin("wf-1", 3, "toolu_a", "generate_pdf", "cust-1")  # crashed: never finished
        attempt = await tool_ledger.begin("wf-1", 3, "toolu_a", "generate_pdf", "cust-1")
        self.assertEqual(attempt, tool_ledger.Attempt(attempt=2, run=False))
        statuses = [(r["attempt"], r["status"]) for r in await self.rows()]
        self.assertEqual(statuses, [(1, "started"), (2, "refused_interrupted")])

    async def test_a_finished_attempt_without_its_memo_is_not_run_again(self):
        # Finished, then the process died before DBOS recorded the step's output.
        await tool_ledger.begin("wf-1", 3, "toolu_a", "http_post", "cust-1")
        await tool_ledger.finish("wf-1", 3, 1, tool_ledger.FINISHED)
        self.assertFalse((await tool_ledger.begin("wf-1", 3, "toolu_a", "http_post", "cust-1")).run)

    async def test_refusals_repeat_on_every_later_execution(self):
        for _ in range(3):
            await tool_ledger.begin("wf-1", 3, "toolu_a", "t", "cust-1")
        self.assertEqual([r["attempt"] for r in await self.rows()], [1, 2, 3])
        self.assertEqual([r["status"] for r in await self.rows()][1:], ["refused_interrupted"] * 2)

    async def test_a_different_call_at_a_recorded_step_is_a_replay_divergence(self):
        await tool_ledger.begin("wf-1", 3, "toolu_a", "t", "cust-1")
        with self.assertRaises(tool_ledger.ReplayDivergence) as caught:
            await tool_ledger.begin("wf-1", 3, "toolu_b", "t", "cust-1")
        self.assertIn("toolu_a", str(caught.exception))
        # DBOS records a step's exception with pickle.
        clone = pickle.loads(pickle.dumps(caught.exception))
        self.assertEqual(str(clone), str(caught.exception))
        self.assertEqual(len(await self.rows()), 1)

    async def test_steps_and_workflows_are_independent(self):
        self.assertTrue((await tool_ledger.begin("wf-1", 3, "toolu_a", "t", "cust-1")).run)
        self.assertTrue((await tool_ledger.begin("wf-1", 5, "toolu_b", "t", "cust-1")).run)
        self.assertTrue((await tool_ledger.begin("wf-2", 3, "toolu_a", "t", "cust-1")).run)

    async def test_a_lost_insert_race_rereads_and_refuses(self):
        await tool_ledger.begin("wf-1", 3, "toolu_a", "t", "cust-1")  # the other writer's row
        real_pool = tool_ledger._pool
        calls = {"n": 0}

        class _RacingConn:
            def __init__(self, conn):
                self._conn = conn

            async def execute(self, sql, params=()):
                if sql.lstrip().startswith("SELECT") and calls["n"] == 0:
                    calls["n"] += 1
                    return _Empty()  # first read misses the other writer's row
                return await self._conn.execute(sql, params)

        class _Empty:
            rowcount = 0

            async def fetchall(self):
                return []

        class _Pool:
            def connection(self):
                return _Ctx()

        class _Ctx:
            async def __aenter__(self):
                self._cm = real_pool.connection()
                return _RacingConn(await self._cm.__aenter__())

            async def __aexit__(self, *exc):
                return await self._cm.__aexit__(*exc)

        tool_ledger._pool = _Pool()
        try:
            attempt = await tool_ledger.begin("wf-1", 3, "toolu_a", "t", "cust-1")
        finally:
            tool_ledger._pool = real_pool
        self.assertEqual(attempt, tool_ledger.Attempt(attempt=2, run=False))


class LedgerHousekeepingTest(_LedgerDB):
    async def test_finish_records_status_time_and_only_the_error_class(self):
        await tool_ledger.begin("wf-1", 3, "toolu_a", "t", "cust-1")
        await tool_ledger.finish("wf-1", 3, 1, tool_ledger.FAILED, "TimeoutError")
        [row] = await self.rows()
        self.assertEqual((row["status"], row["error_class"]), ("failed", "TimeoutError"))
        self.assertIsNotNone(row["finished_at"])

    async def test_purge_by_workflow_and_by_customer(self):
        await tool_ledger.begin("wf-1", 3, "toolu_a", "t", "cust-1")
        await tool_ledger.begin("wf-2", 3, "toolu_b", "t", "cust-1")
        await tool_ledger.begin("wf-3", 3, "toolu_c", "t", "cust-2")
        self.assertEqual(await tool_ledger.delete_workflow("wf-1"), 1)
        self.assertEqual(await tool_ledger.delete_workflow("wf-1"), 0)  # idempotent
        self.assertEqual(await tool_ledger.delete_customer("cust-1"), 1)
        self.assertEqual(await tool_ledger.delete_customer("cust-1"), 0)
        self.assertEqual([r["workflow_id"] for r in await self.rows("wf-3")], ["wf-3"])

    async def test_prune_by_age(self):
        await tool_ledger.begin("wf-1", 3, "toolu_a", "t", "cust-1")
        real_now = tool_ledger._now()
        with patch.object(tool_ledger, "_now", lambda: real_now - timedelta(days=8)):
            await tool_ledger.begin("wf-old", 3, "toolu_z", "t", "cust-1")
        self.assertEqual(await tool_ledger.delete_older_than(7 * 24 * 3600), 1)
        self.assertEqual(len(await self.rows("wf-1")), 1)
        self.assertEqual(await self.rows("wf-old"), [])

    async def test_rows_hold_no_arguments(self):
        tool = _Tool()
        context = ToolContext(customer_id="cust-1", store=_MemoryStore())
        call = {"id": "toolu_a", "name": "t", "args": {"body": "SECRET-ARGUMENT-123"}}
        await tool_executor_module._invoke_with_ledger(tool, call, context, "wf-1", 3)
        [row] = await self.rows()
        self.assertNotIn("SECRET-ARGUMENT-123", repr(row))


class _Tool(GraphTool):
    name = "t"
    description = "stores files"
    parameters = {"type": "object", "properties": {}}

    def __init__(self, files=1, raises=None):
        self.files, self.raises, self.contexts = files, raises, []

    async def run(self, args, context):
        self.contexts.append(context)
        if self.raises:
            raise self.raises
        artifacts = [context.save_artifact(b"x", "application/pdf", f"f{i}.pdf") for i in range(self.files)]
        return ToolResult(content="ok", artifacts=artifacts)


class InvokeWithLedgerTest(_LedgerDB):
    def _context(self):
        return ToolContext(customer_id="cust-1", store=_MemoryStore(),
                           key_template="customers/{customer_id}/attachments/{artifact_id}")

    async def test_runs_the_tool_with_a_per_call_seed_and_records_the_finish(self):
        tool, context = _Tool(), self._context()
        call = {"id": "toolu_a", "name": "t", "args": {}}
        result, error = await tool_executor_module._invoke_with_ledger(tool, call, context, "wf-1", 3)
        self.assertIsNone(error)
        self.assertEqual(result.content, "ok")
        self.assertEqual(tool.contexts[0].artifact_seed, "cust-1:wf-1:3:toolu_a")
        self.assertIsNone(context.artifact_seed)  # the shared context is untouched
        self.assertIs(tool.contexts[0].runtime, context.runtime)
        self.assertEqual([r["status"] for r in await self.rows()], ["finished"])

    async def test_a_refused_call_returns_the_interrupted_error_without_running(self):
        tool, context = _Tool(), self._context()
        call = {"id": "toolu_a", "name": "t", "args": {"x": 1}}
        await tool_ledger.begin("wf-1", 3, "toolu_a", "t", "cust-1")  # the crashed attempt
        before = durable_metrics.TOOL_CALL_INTERRUPTED.labels(tool="t")._value.get()
        result, error = await tool_executor_module._invoke_with_ledger(tool, call, context, "wf-1", 3)
        self.assertIsNone(result)
        self.assertEqual(error, tool_ledger.INTERRUPTED_MESSAGE)
        self.assertEqual(
            error, "This tool call was interrupted when the server restarted and was not run again.")
        self.assertEqual(tool.contexts, [])
        self.assertEqual(durable_metrics.TOOL_CALL_INTERRUPTED.labels(tool="t")._value.get() - before, 1)

    async def test_a_failing_tool_is_a_tool_error_and_records_its_class(self):
        tool = _Tool(raises=ValueError("bad input"))
        result, error = await tool_executor_module._invoke_with_ledger(
            tool, {"id": "toolu_a", "name": "t"}, self._context(), "wf-1", 3)
        self.assertEqual((result, error), (None, "bad input"))
        [row] = await self.rows()
        self.assertEqual((row["status"], row["error_class"]), ("failed", "ValueError"))

    async def test_a_divergence_propagates(self):
        await tool_ledger.begin("wf-1", 3, "toolu_a", "t", "cust-1")
        with self.assertRaises(tool_ledger.ReplayDivergence):
            await tool_executor_module._invoke_with_ledger(
                _Tool(), {"id": "toolu_other", "name": "t"}, self._context(), "wf-1", 3)

    async def test_a_ledger_write_failure_after_the_tool_ran_keeps_the_result(self):
        with patch.object(tool_ledger, "finish", side_effect=psycopg.errors.UniqueViolation("x")):
            result, error = await tool_executor_module._invoke_with_ledger(
                _Tool(), {"id": "toolu_a", "name": "t"}, self._context(), "wf-1", 3)
        self.assertIsNone(error)
        self.assertEqual(result.content, "ok")


class ArtifactIdTest(unittest.TestCase):
    def _context(self, seed=None):
        context = ToolContext(customer_id="cust-1", store=_MemoryStore(),
                              key_template="customers/{customer_id}/attachments/{artifact_id}")
        return dataclasses.replace(context, artifact_seed=seed) if seed else context

    def test_same_seed_same_ids_in_order(self):
        first = self._context("cust-1:wf-1:3:toolu_a")
        second = self._context("cust-1:wf-1:3:toolu_a")
        ids_1 = [first.save_artifact(b"x", "application/pdf", "a.pdf").artifact_id for _ in range(2)]
        ids_2 = [second.save_artifact(b"y", "application/pdf", "a.pdf").artifact_id for _ in range(2)]
        self.assertEqual(ids_1, ids_2)
        self.assertNotEqual(ids_1[0], ids_1[1])  # the per-call counter
        expected = uuid.uuid5(graph_tools_base._ARTIFACT_ID_NAMESPACE, "cust-1:wf-1:3:toolu_a:1")
        self.assertEqual(ids_1[0], str(expected))

    def test_the_key_follows_the_id(self):
        artifact = self._context("seed").save_artifact(b"x", "application/pdf", "a.pdf")
        self.assertEqual(artifact.key, f"customers/cust-1/attachments/{artifact.artifact_id}")

    def test_different_calls_get_different_ids(self):
        a = self._context("cust-1:wf-1:3:toolu_a").save_artifact(b"x", "t", "a").artifact_id
        b = self._context("cust-1:wf-1:5:toolu_b").save_artifact(b"x", "t", "a").artifact_id
        self.assertNotEqual(a, b)

    def test_no_seed_mints_a_random_uuid4(self):
        context = self._context()
        ids = {context.save_artifact(b"x", "t", "a").artifact_id for _ in range(3)}
        self.assertEqual(len(ids), 3)
        self.assertTrue(all(uuid.UUID(i).version == 4 for i in ids))

    def test_replace_resets_the_counter(self):
        base_context = self._context("s")
        base_context.save_artifact(b"x", "t", "a")
        again = dataclasses.replace(base_context, artifact_seed="s")
        self.assertEqual(again.save_artifact(b"x", "t", "a").artifact_id,
                         str(uuid.uuid5(graph_tools_base._ARTIFACT_ID_NAMESPACE, "s:1")))


class ExecutorReplayErrorTest(unittest.IsolatedAsyncioTestCase):
    """_run_one turns every tool failure into a tool error — except a replay
    divergence, which must fail the run."""

    async def test_a_divergence_escapes_the_executor(self):
        async def diverging_step(tool, call, context):
            raise tool_ledger.ReplayDivergence("wf-1", 3, "toolu_a", "toolu_b")

        state = {"customer_id": "cust-1", "tool_calls": [{"id": "toolu_b", "name": "t", "args": {}}],
                 "builtin_tools": ["t"], "generated_response": ""}
        with patch.object(tool_executor_module, "tools_for", return_value=[_Tool()]), \
                patch.object(tool_executor_module, "_durable_workflow_id", return_value="wf-1"), \
                patch.object(tool_executor_module, "_durable_tool_invoke", diverging_step):
            with self.assertRaises(tool_ledger.ReplayDivergence):
                await tool_executor_module.tool_executor("node-1")(state)

    async def test_durable_path_uses_the_step_and_derives_the_fs_namespace(self):
        seen = {}

        async def step(tool, call, context):
            seen["call"], seen["ns"] = call, context.runtime["fs_namespace"]
            return ToolResult(content="from the step"), None

        state = {"customer_id": "cust-1", "tool_calls": [{"id": "toolu_a", "name": "t", "args": {}}],
                 "builtin_tools": ["t"], "generated_response": ""}
        with patch.object(tool_executor_module, "tools_for", return_value=[_Tool()]), \
                patch.object(tool_executor_module, "_durable_workflow_id", return_value="wf-1"), \
                patch.object(tool_executor_module, "_durable_tool_invoke", step):
            out = await tool_executor_module.tool_executor("node-1")(state)
        self.assertEqual(out["loop_messages"][1]["content"], "from the step")
        expected_ns = uuid.uuid5(tool_executor_module._FS_NAMESPACE_UUID, "wf-1").hex
        self.assertEqual(seen["ns"], expected_ns)
        self.assertEqual(out["scratch"]["fs_namespace"], expected_ns)

    async def test_spawn_agent_is_not_wrapped_in_a_step(self):
        class _Spawn(_Tool):
            name = "spawn_agent"

        async def step(tool, call, context):
            raise AssertionError("composite tools must not run as a step")

        tool = _Spawn(files=0)
        state = {"customer_id": "cust-1", "tool_calls": [{"id": "toolu_a", "name": "spawn_agent", "args": {}}],
                 "builtin_tools": ["spawn_agent"], "generated_response": ""}
        with patch.object(tool_executor_module, "tools_for", return_value=[tool]), \
                patch.object(tool_executor_module, "_durable_workflow_id", return_value="wf-1"), \
                patch.object(tool_executor_module, "_durable_tool_invoke", step):
            out = await tool_executor_module.tool_executor("node-1")(state)
        self.assertEqual(out["loop_messages"][1]["content"], "ok")
        self.assertEqual(len(tool.contexts), 1)

    async def test_stateless_path_keeps_a_random_fs_namespace(self):
        state = {"customer_id": "cust-1", "tool_calls": [{"id": "toolu_a", "name": "t", "args": {}}],
                 "builtin_tools": ["t"], "generated_response": ""}
        with patch.object(tool_executor_module, "tools_for", return_value=[_Tool()]):
            first = await tool_executor_module.tool_executor("node-1")(dict(state))
            second = await tool_executor_module.tool_executor("node-1")(dict(state))
        self.assertNotEqual(first["scratch"]["fs_namespace"], second["scratch"]["fs_namespace"])


if __name__ == "__main__":
    unittest.main()
