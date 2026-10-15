"""
Unit tests for how a durable run reports its own failures (runs.py, plan 0.2).

A run that ends with resume_timeout or the runaway guard publishes a
standalone {"error", "error_type"} row right before its terminal summary
(contract C5) — inside the summary the proxy's parser could take
`generated_artifacts` first and never show the error. A stream error is
already its own row and is not published twice. A workflow that raises is
counted as an errored agent_run. No DBOS, no database: graph, checkpointer and
run_events are faked as in test_runs.py.

Run with `python -m unittest tests.test_runs_failures`.
"""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from dbos import DBOS

import run_events
import runs

_RUN_INPUT = {
    "customer_id": "cust-1", "client": "test", "data_type": "conversation",
    "raw_data": {"query_data": "hi"}, "llm_provider": "anthropic", "agentic": True,
}


class _InterruptingGraph:
    """Every invocation pauses on interrupt() (a HUMAN_INPUT node)."""

    def __init__(self, boom=False):
        self.boom = boom

    async def astream_events(self, state, config=None, version=None):
        yield {"event": "on_chain_start", "name": "ask", "metadata": {"langgraph_node": "ask"}}
        if self.boom:
            raise RuntimeError("rate limit exceeded")

    async def aget_state(self, config):
        return SimpleNamespace(
            values={"generated_response": None, "generated_artifacts": [], "usage": {"total_tokens": 3}},
            interrupts=[SimpleNamespace(value={"question": "Which one?"})],
            tasks=[],
        )


def _resolver(graph):
    def resolve(customer_id, graph_id, checkpointer):
        return graph, {"ask": "HUMAN_INPUT"}, {"ask": "Ask"}, {"ask": {}}, set(), 10
    return resolve


async def _run(graph, recv=None, **patches):
    published = []

    async def fake_publish(run_id, event, terminal=False):
        published.append((event, terminal))
        return len(published)

    with patch.object(runs, "_resolve_durable_graph", _resolver(graph)), \
            patch.object(runs.durable_runtime, "get_checkpointer", lambda: object()), \
            patch.object(run_events, "publish", fake_publish), \
            patch.object(DBOS, "recv_async", recv or AsyncMock(return_value=None)):
        for name, value in patches.items():
            setattr(runs, name, value)
        summary = await runs._run_agent_graph("run_x", dict(_RUN_INPUT))
    return summary, published


class OwnFailureRowsTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._max_cycles = runs._MAX_RESUME_CYCLES

    def tearDown(self):
        runs._MAX_RESUME_CYCLES = self._max_cycles

    def _assert_error_row_before_terminal(self, published, error_type):
        terminal_index = next(i for i, (_, term) in enumerate(published) if term)
        self.assertEqual(terminal_index, len(published) - 1)
        standalone = published[terminal_index - 1][0]
        self.assertEqual(set(standalone), {"error", "error_type"})
        self.assertEqual(standalone["error_type"], error_type)
        terminal = published[terminal_index][0]
        self.assertEqual(terminal["status"], "error")
        self.assertEqual(terminal["error_type"], error_type)
        self.assertEqual(terminal["error"], standalone["error"])
        return standalone

    async def test_resume_timeout_publishes_a_standalone_error_row(self):
        summary, published = await _run(_InterruptingGraph())
        standalone = self._assert_error_row_before_terminal(published, "resume_timeout")
        self.assertTrue(standalone["error"])
        self.assertEqual(summary["error_type"], "resume_timeout")
        # The human-input request went out before the wait.
        self.assertTrue(any("awaiting_input" in ev for ev, _ in published))

    async def test_runaway_guard_publishes_a_standalone_error_row(self):
        _, published = await _run(_InterruptingGraph(), _MAX_RESUME_CYCLES=0)
        self._assert_error_row_before_terminal(published, "runaway")

    async def test_a_stream_error_is_not_published_twice(self):
        _, published = await _run(_InterruptingGraph(boom=True))
        errors = [ev for ev, term in published if not term and "error" in ev]
        self.assertEqual(len(errors), 1)
        self.assertEqual(published[-1][0]["status"], "error")

    async def test_a_raising_workflow_is_counted_as_an_errored_run(self):
        def broken(customer_id, graph_id, checkpointer):
            raise ValueError("Agent 'g' not found")

        with patch.object(runs, "_resolve_durable_graph", broken), \
                patch.object(runs.durable_runtime, "get_checkpointer", lambda: object()), \
                patch.object(runs, "count") as count:
            with self.assertRaises(ValueError):
                await runs._run_agent_graph("run_x", dict(_RUN_INPUT))
        count.assert_any_call("agent_run_total", status="error", source="conversation")


if __name__ == "__main__":
    unittest.main()
