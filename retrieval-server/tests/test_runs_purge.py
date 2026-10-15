"""
Tests for purging durable-run data (plan 3.9, retrieval-server parts).

  * DELETE /runs/{id}/data calls the four deletes (DBOS rows, checkpoints,
    run_events, tool ledger), answers 204 — again on a repeat — and refuses a
    run that may still execute (409). Against real DBOS, every store is shown
    empty afterwards in test_durable_replay.py.
  * A durable request agent (execute_agent_graph, durable=true) runs under
    workflow id = run id, and its DBOS rows and checkpoints are deleted when
    the route returns (DBOS on SQLite, subprocess harness).

Run with `python -m unittest tests.test_runs_purge`.
"""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

import durable_runtime
import runs
from routes import runs as runs_routes
from tests.durable_harness import parse_result, read_lines

RETRIEVAL_DIR = Path(__file__).resolve().parents[1]


class DeleteRunDataRouteTest(unittest.IsolatedAsyncioTestCase):
    async def _call(self, status):
        purge = AsyncMock()

        async def fake_status(run_id):
            return None if status is None else SimpleNamespace(status=status)

        with patch.object(durable_runtime, "is_ready", lambda: True), \
                patch.object(runs_routes, "_status", fake_status), \
                patch.object(runs, "delete_run_data", purge):
            response = await runs_routes.delete_run_data("run_1")
        return response, purge

    async def test_a_finished_run_is_purged_with_204(self):
        for status in ("SUCCESS", "ERROR", "CANCELLED", "MAX_RECOVERY_ATTEMPTS_EXCEEDED"):
            response, purge = await self._call(status)
            self.assertEqual(response.status_code, 204, status)
            purge.assert_awaited_once_with("run_1")

    async def test_an_unknown_or_already_purged_run_is_204(self):
        response, purge = await self._call(None)
        self.assertEqual(response.status_code, 204)
        purge.assert_awaited_once_with("run_1")

    async def test_a_run_that_may_still_execute_is_refused(self):
        for status in ("PENDING", "ENQUEUED"):
            with self.assertRaises(HTTPException) as caught:
                await self._call(status)
            self.assertEqual(caught.exception.status_code, 409, status)

    async def test_a_failed_delete_is_a_500_to_retry(self):
        async def fake_status(run_id):
            return None

        with patch.object(durable_runtime, "is_ready", lambda: True), \
                patch.object(runs_routes, "_status", fake_status), \
                patch.object(runs, "delete_run_data", AsyncMock(side_effect=RuntimeError("db down"))):
            with self.assertRaises(HTTPException) as caught:
                await runs_routes.delete_run_data("run_1")
        self.assertEqual(caught.exception.status_code, 500)


class DeleteRunDataHelperTest(unittest.IsolatedAsyncioTestCase):
    async def test_calls_all_four_deletes(self):
        import run_events
        import tool_ledger
        from dbos import DBOS

        checkpointer = SimpleNamespace(adelete_thread=AsyncMock())
        with patch.object(DBOS, "delete_workflows_async", AsyncMock()) as dbos_delete, \
                patch.object(durable_runtime, "get_checkpointer", lambda: checkpointer), \
                patch.object(run_events, "delete_run", AsyncMock()) as events_delete, \
                patch.object(tool_ledger, "delete_workflow", AsyncMock()) as ledger_delete:
            await runs.delete_run_data("run_1")
        dbos_delete.assert_awaited_once_with(["run_1"], delete_children=True)
        checkpointer.adelete_thread.assert_awaited_once_with("run_1")
        events_delete.assert_awaited_once_with("run_1")
        ledger_delete.assert_awaited_once_with("run_1")

    async def test_request_run_checkpoints_go_before_the_dbos_rows(self):
        from dbos import DBOS

        order = []
        checkpointer = SimpleNamespace(adelete_thread=AsyncMock(side_effect=lambda t: order.append(("cp", t))))
        dbos_delete = AsyncMock(side_effect=lambda ids, delete_children: order.append(("dbos", ids)))
        with patch.object(DBOS, "delete_workflows_async", dbos_delete), \
                patch.object(durable_runtime, "get_checkpointer", lambda: checkpointer):
            await runs.delete_request_run("wf-uuid", "ra-123")
        self.assertEqual(order, [("cp", "ra-123"), ("dbos", ["wf-uuid"])])


class DurableRequestAgentTest(unittest.TestCase):
    def test_request_agent_rows_and_checkpoints_are_gone_after_the_response(self):
        directory = tempfile.mkdtemp(prefix="durable-request-agent-")
        env = dict(os.environ, DBOS_APP_VERSION="test-purge-1")
        env.pop("DATABASE_URL", None)
        proc = subprocess.run(
            [sys.executable, "-m", "tests.durable_harness", "request_agent", "--variant", "request",
             "--dir", directory],
            cwd=RETRIEVAL_DIR, env=env, capture_output=True, text=True, timeout=180,
        )
        result = parse_result(proc.stdout)
        self.assertEqual(proc.returncode, 0, proc.stderr[-3000:])
        self.assertEqual(result["status_code"], 200)
        self.assertEqual(result["body"]["generated_response"], "A short title")
        self.assertEqual(result["remaining"], [])       # DBOS rows deleted
        self.assertEqual(result["threads_after"], [])   # checkpoints deleted
        [call] = read_lines(directory, "llm_bodies.log")
        self.assertTrue(call["workflow_id"].startswith("ra-"))  # workflow id = run id


if __name__ == "__main__":
    unittest.main()


class DeleteCustomerRunDataTest(unittest.IsolatedAsyncioTestCase):
    """DELETE /customers/{id}/run-data (plan 3.9 step 7): every run whose
    input is the customer's, found by listing workflows, not message rows."""

    @staticmethod
    def _wf(run_id, status, customer, name="agent_run", as_kwargs=False):
        run_input = {"customer_id": customer, "raw_data": {"query_data": "hi"}}
        inputs = {"args": (run_id,), "kwargs": {"run_input": run_input}} if as_kwargs \
            else {"args": (run_id, run_input), "kwargs": {}}
        return SimpleNamespace(workflow_id=run_id, status=status, name=name, input=inputs)

    async def _purge(self, workflows, page_size=200):
        import tool_ledger
        from dbos import DBOS

        listed = []

        async def list_workflows(**kwargs):
            listed.append(kwargs)
            offset, limit = kwargs["offset"], kwargs["limit"]
            return workflows[offset:offset + limit]

        purge = AsyncMock()
        cancel = AsyncMock()
        with patch.object(runs, "_CUSTOMER_RUN_PAGE", page_size), \
                patch.object(DBOS, "list_workflows_async", list_workflows), \
                patch.object(DBOS, "cancel_workflow_async", cancel), \
                patch.object(runs, "delete_run_data", purge), \
                patch.object(tool_ledger, "delete_customer", AsyncMock(return_value=3)) as ledger:
            result = await runs.delete_customer_run_data("CU1")
        return result, purge, cancel, ledger, listed

    async def test_only_the_customers_finished_runs_are_purged_across_pages(self):
        workflows = [
            self._wf("run_a", "SUCCESS", "CU1"),
            self._wf("run_b", "SUCCESS", "CU2"),
            self._wf("ra-c", "ERROR", "CU1", name="request_agent_run"),
            self._wf("run_d", "CANCELLED", "CU1", as_kwargs=True),
            self._wf("run_e", "SUCCESS", "CU10"),
        ]
        result, purge, cancel, ledger, listed = await self._purge(workflows, page_size=2)

        self.assertEqual(sorted(c.args[0] for c in purge.await_args_list), ["ra-c", "run_a", "run_d"])
        cancel.assert_not_awaited()
        ledger.assert_awaited_once_with("CU1")
        self.assertEqual(result, {"deleted": 3, "active": 0, "ledger_rows": 3})
        self.assertEqual([c["offset"] for c in listed], [0, 2, 4])
        self.assertTrue(all(c["load_input"] and not c["load_output"] for c in listed))
        self.assertEqual(listed[0]["name"], ["agent_run", "request_agent_run"])

    async def test_a_run_that_may_still_execute_is_cancelled_not_purged(self):
        result, purge, cancel, _, _ = await self._purge([
            self._wf("run_a", "PENDING", "CU1"), self._wf("run_b", "SUCCESS", "CU1"),
        ])
        cancel.assert_awaited_once_with("run_a")
        purge.assert_awaited_once_with("run_b")
        self.assertEqual((result["deleted"], result["active"]), (1, 1))

    async def test_the_route_answers_409_while_runs_are_active_and_refuses_bad_ids(self):
        with patch.object(durable_runtime, "is_ready", lambda: True), \
                patch.object(runs, "delete_customer_run_data",
                             AsyncMock(return_value={"deleted": 1, "active": 1, "ledger_rows": 0})):
            response = await runs_routes.delete_customer_run_data("CU1")
        self.assertEqual(response.status_code, 409)

        with patch.object(durable_runtime, "is_ready", lambda: True), \
                patch.object(runs, "delete_customer_run_data",
                             AsyncMock(return_value={"deleted": 2, "active": 0, "ledger_rows": 1})):
            self.assertEqual((await runs_routes.delete_customer_run_data("CU1"))["deleted"], 2)

        for bad in ("System", "../CU1", "CU 1", ""):
            with patch.object(durable_runtime, "is_ready", lambda: True):
                with self.assertRaises(HTTPException) as caught:
                    await runs_routes.delete_customer_run_data(bad)
            self.assertEqual(caught.exception.status_code, 400, bad)
