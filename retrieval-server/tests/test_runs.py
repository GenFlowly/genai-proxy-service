"""
Unit tests for the durable-run workflow body (runs._run_agent_graph) and the
RunRequest→RetrieveRequest mapping — no live DB, no DBOS, no LLM.

The graph, checkpointer and run_events channel are faked, so this exercises the
pure orchestration logic: event fan-out to the channel, the terminal status
event, credentials left unset (resolved from DDB downstream), and the summary
read from the checkpointed final state. Run with:
    .venv/bin/python -m unittest tests.test_runs
"""
import asyncio
import unittest
from unittest.mock import patch

import run_events
import runs
from models import RunRequest


class _FakeChunk:
    content = "Hello world"


class _FakeSnap:
    values = {
        "customer_id": "cust-1",
        "generated_response": "Hello world",
        "tool_calls": None,
        "generated_artifacts": [{"artifact_id": "a1"}],
        "usage": {"total_tokens": 42},
        "error": None,
    }


class _FakeGraph:
    def __init__(self, boom: bool = False):
        self.boom = boom

    async def astream_events(self, state, config=None, version=None):
        # A checkpointer-bound graph REQUIRES thread_id in config — assert the
        # workflow threaded it through.
        assert config.get("configurable", {}).get("thread_id"), "thread_id not passed to graph"
        yield {"event": "on_chain_start", "name": "n", "metadata": {"langgraph_node": "n"}}
        if self.boom:
            raise RuntimeError("rate limit exceeded")
        yield {"event": "on_chat_model_stream", "name": "x",
               "metadata": {"langgraph_node": "n"}, "data": {"chunk": _FakeChunk()}}

    async def aget_state(self, config):
        return _FakeSnap()


def _fake_resolve(customer_id, graph_id, checkpointer):
    return _FakeGraph(), {"n": "RESPONSE_GENERATOR"}, {"n": "Gen"}, {"n": {}}, {"n"}, 10


def _fake_resolve_boom(customer_id, graph_id, checkpointer):
    return _FakeGraph(boom=True), {"n": "RESPONSE_GENERATOR"}, {"n": "Gen"}, {"n": {}}, {"n"}, 10


class _CancelledGraph(_FakeGraph):
    """The preemptible LLM step aborted mid-call by POST /runs/{id}/cancel."""

    async def astream_events(self, state, config=None, version=None):
        from dbos._error import DBOSWorkflowCancelledError

        yield {"event": "on_chain_start", "name": "n", "metadata": {"langgraph_node": "n"}}
        raise DBOSWorkflowCancelledError("Workflow run_x is cancelled. Aborting preemptible step.")


def _fake_resolve_cancelled(customer_id, graph_id, checkpointer):
    return _CancelledGraph(), {"n": "RESPONSE_GENERATOR"}, {"n": "Gen"}, {"n": {}}, {"n"}, 10


_RUN_INPUT = {
    "customer_id": "cust-1", "client": "test", "data_type": "conversation",
    "raw_data": {"query_data": "hi"}, "llm_provider": "anthropic", "agentic": True,
}


class RunRequestTest(unittest.TestCase):
    def test_excludes_credentials_and_stream(self):
        fields = set(RunRequest.model_fields)
        self.assertNotIn("llm_credentials", fields)
        self.assertNotIn("stream", fields)

    def test_maps_onto_retrieve_request_with_empty_creds(self):
        from models import RetrieveRequest
        req = RunRequest.model_validate(_RUN_INPUT)
        # Same reconstruction the workflow does — must validate with empty creds.
        rr = RetrieveRequest.model_validate({**req.model_dump(exclude={"run_id"}),
                                             "llm_credentials": {}, "stream": True})
        self.assertEqual(rr.llm_credentials, {})
        self.assertEqual(rr.raw_data.query_data, "hi")
        self.assertEqual(rr.llm_provider, "anthropic")


class RunAgentGraphTest(unittest.IsolatedAsyncioTestCase):
    async def _run(self, resolve, already_published: int = 0):
        published = []

        async def fake_publish(run_id, event, terminal=False):
            published.append((run_id, event, terminal))
            return len(published)

        async def fake_latest_seq(run_id):
            return already_published

        with patch.object(runs, "_resolve_durable_graph", resolve), \
             patch.object(runs.durable_runtime, "get_checkpointer", lambda: object()), \
             patch.object(run_events, "publish", fake_publish), \
             patch.object(run_events, "latest_seq", fake_latest_seq), \
             patch.object(runs.allocator, "release_soon") as self.release_soon:
            summary = await runs._run_agent_graph("run_x", dict(_RUN_INPUT))
        return summary, published

    async def test_a_run_that_ends_schedules_a_memory_release(self):
        await self._run(_fake_resolve)
        self.release_soon.assert_called_once()

    async def test_happy_path_streams_and_summarizes(self):
        summary, published = await self._run(_fake_resolve)

        kinds = [next(iter(ev)) for _, ev, _ in published if not _is_terminal(ev)]
        # activity, content, usage streamed before the terminal event
        self.assertIn("content", [k for k in kinds])
        content = "".join(ev["content"] for _, ev, _ in published if "content" in ev)
        self.assertEqual(content, "Hello world")

        # Exactly one terminal event, last, status=completed, no secret fields
        terminals = [(ev, term) for _, ev, term in published if term]
        self.assertEqual(len(terminals), 1)
        term_ev, _ = terminals[0]
        self.assertEqual(term_ev["status"], "completed")
        self.assertEqual(published[-1][2], True)  # terminal is last

        # Summary reads generated_response/artifacts from the checkpointed state
        self.assertEqual(summary["generated_response"], "Hello world")
        self.assertEqual(summary["generated_artifacts"], [{"artifact_id": "a1"}])
        self.assertIsNone(summary["error"])
        self.assertNotIn("llm_credentials", summary)

    async def test_a_fresh_run_publishes_no_restart_marker(self):
        _, published = await self._run(_fake_resolve)

        self.assertFalse(any("run_restarted" in ev for _, ev, _ in published))

    async def test_a_recovered_run_marks_the_restart_before_its_new_events(self):
        _, published = await self._run(_fake_resolve, already_published=7)

        self.assertEqual(published[0][1], {"run_restarted": True})
        self.assertEqual(sum("run_restarted" in ev for _, ev, _ in published), 1)
        self.assertTrue(published[-1][2], "the rerun still ends on a terminal event")

    async def test_the_activity_log_opens_and_closes_the_run_once(self):
        # One recorder spans the whole run: a single turn.start first, a single
        # turn.end after the graph finished, both before the terminal event.
        _, published = await self._run(_fake_resolve)

        activity = [ev["activity"] for _, ev, term in published if not term and "activity" in ev]
        kinds = [a["type"] for a in activity]
        self.assertEqual(kinds[0], "turn.start")
        self.assertEqual(kinds.count("turn.start"), 1)
        self.assertEqual(kinds[-1], "turn.end")
        self.assertEqual(kinds.count("turn.end"), 1)
        self.assertEqual(activity[-1]["outcome"], "completed")
        last_activity = max(i for i, (_, ev, _) in enumerate(published) if "activity" in ev)
        terminal = next(i for i, (_, _, term) in enumerate(published) if term)
        self.assertLess(last_activity, terminal)

    async def test_graph_error_becomes_error_status(self):
        summary, published = await self._run(_fake_resolve_boom)

        # stream_events_dicts converts the raised error into an {'error': …} event
        self.assertTrue(any("error" in ev and ev.get("error") for _, ev, term in published if not term))
        terminals = [ev for _, ev, term in published if term]
        self.assertEqual(len(terminals), 1)
        self.assertEqual(terminals[0]["status"], "error")
        self.assertTrue(summary["error"])


    async def test_cancelled_run_publishes_no_terminal_and_counts_cancelled(self):
        from dbos._error import DBOSWorkflowCancelledError

        with patch.object(runs, "count") as counted:
            with self.assertRaises(DBOSWorkflowCancelledError):
                await self._run(_fake_resolve_cancelled)

        counted.assert_any_call("agent_run_total", status="cancelled", source="conversation")


    async def test_a_cancel_signalled_here_stops_publishing_at_the_next_event(self):
        from dbos._error import DBOSWorkflowCancelledError

        published = []

        async def publish_then_cancel(run_id, event, terminal=False):
            published.append(event)
            self.assertTrue(runs.signal_cancel(run_id))
            return len(published)

        async def no_events(run_id):
            return 0

        with patch.object(runs, "_resolve_durable_graph", _fake_resolve), \
             patch.object(runs.durable_runtime, "get_checkpointer", lambda: object()), \
             patch.object(run_events, "publish", publish_then_cancel), \
             patch.object(run_events, "latest_seq", no_events):
            with self.assertRaises(DBOSWorkflowCancelledError):
                await runs._run_agent_graph("run_x", dict(_RUN_INPUT))

        self.assertEqual(len(published), 1)
        self.assertFalse(runs.signal_cancel("run_x"), "the run's stop signal outlives it")


class _SlowGraph(_FakeGraph):
    """Counts how many runs are inside the graph at once."""
    inside = 0
    most = 0

    async def astream_events(self, state, config=None, version=None):
        type(self).inside += 1
        type(self).most = max(type(self).most, type(self).inside)
        try:
            await asyncio.sleep(0.05)
            async for event in super().astream_events(state, config, version):
                yield event
        finally:
            type(self).inside -= 1


def _slow_resolve(customer_id, graph_id, checkpointer):
    return _SlowGraph(), {"n": "RESPONSE_GENERATOR"}, {"n": "Gen"}, {"n": {}}, {"n"}, 10


class RecoveryPacingTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        _SlowGraph.inside = _SlowGraph.most = 0
        self.published = {}

        async def fake_publish(run_id, event, terminal=False):
            self.published.setdefault(run_id, []).append(event)
            return len(self.published[run_id])

        async def fake_latest_seq(run_id):
            return 7 if run_id.startswith("recovered") else 0

        for p in (patch.object(runs, "_resolve_durable_graph", _slow_resolve),
                  patch.object(runs.durable_runtime, "get_checkpointer", lambda: object()),
                  patch.object(run_events, "publish", fake_publish),
                  patch.object(run_events, "latest_seq", fake_latest_seq),
                  patch.object(runs.allocator, "release_soon"),
                  patch.object(runs, "_RECOVERY_CONCURRENCY", 1),
                  patch.object(runs, "_RECOVERY_POLL_SEC", 0.005),
                  patch.object(runs, "_RECOVERY_HEARTBEAT_SEC", 0.0)):
            p.start()
            self.addCleanup(p.stop)

    async def test_recovered_runs_take_turns_and_queued_ones_publish_heartbeats(self):
        await asyncio.gather(*(runs._run_agent_graph(f"recovered-{i}", dict(_RUN_INPUT)) for i in range(3)))
        self.assertEqual(_SlowGraph.most, 1)
        heartbeats = [sum("recovery_queued" in e for e in evs) for evs in self.published.values()]
        self.assertEqual(sorted(heartbeats)[0], 0)  # the first one never waited
        self.assertTrue(all(h > 0 for h in sorted(heartbeats)[1:]))
        for evs in self.published.values():
            self.assertEqual(evs[0], {"run_restarted": True})  # the marker comes before any heartbeat
            self.assertIn("status", evs[-1])
        self.assertEqual(runs._recovering, 0)

    async def test_runs_started_normally_are_never_paced(self):
        await asyncio.gather(*(runs._run_agent_graph(f"fresh-{i}", dict(_RUN_INPUT)) for i in range(3)))
        self.assertEqual(_SlowGraph.most, 3)
        self.assertFalse(any("recovery_queued" in e for evs in self.published.values() for e in evs))

    async def test_a_cancel_reaches_a_queued_recovered_run(self):
        from dbos._error import DBOSWorkflowCancelledError

        with patch.object(runs, "_recovering", 1):  # the only slot is taken
            task = asyncio.ensure_future(runs._run_agent_graph("recovered-x", dict(_RUN_INPUT)))
            await asyncio.sleep(0.05)
            self.assertTrue(runs.signal_cancel("recovered-x"))
            with self.assertRaises(DBOSWorkflowCancelledError):
                await task
        self.assertEqual(_SlowGraph.most, 0)


class CancelRouteTest(unittest.IsolatedAsyncioTestCase):
    async def test_cancels_through_the_async_dbos_api(self):
        from dbos import DBOS

        import routes.runs as runs_route

        cancelled = []

        async def fake_cancel(run_id, **kwargs):
            cancelled.append((run_id, kwargs))

        async def fake_status(run_id):
            return object()

        async def fake_delete(run_id):
            return None

        def sync_cancel_refused(*args, **kwargs):
            raise AssertionError("sync cancel_workflow raises inside an event loop")

        with patch.object(runs_route, "_require_ready", lambda: None), \
             patch.object(runs_route, "_status", fake_status), \
             patch.object(run_events, "delete_run", fake_delete), \
             patch.object(DBOS, "cancel_workflow_async", fake_cancel, create=True), \
             patch.object(DBOS, "cancel_workflow", sync_cancel_refused, create=True), \
             patch.object(runs, "signal_cancel") as signalled:
            body = await runs_route.cancel_run("run_x")

        # Subagents run as child workflows; Stop must cancel them too.
        self.assertEqual(cancelled, [("run_x", {"cancel_children": True})])
        signalled.assert_called_once_with("run_x")
        self.assertEqual(body["status"], "cancelled")


class StartRunTest(unittest.IsolatedAsyncioTestCase):
    async def test_starts_the_workflow_directly_under_the_run_id(self):
        from dbos import DBOS
        from dbos._context import get_workflow_start_options

        seen = {}

        async def fake_start(func, *args):
            seen["func"], seen["args"] = func, args
            seen["workflow_id"] = get_workflow_start_options().assigned_id.workflow_id
            return "handle"

        with patch.object(runs.durable_runtime, "is_ready", return_value=True), \
             patch.object(DBOS, "start_workflow_async", fake_start):
            handle = await runs.start_run("run_x", dict(_RUN_INPUT))

        self.assertEqual(handle, "handle")
        self.assertIs(seen["func"], runs.agent_run)
        self.assertEqual(seen["args"], ("run_x", _RUN_INPUT))
        self.assertEqual(seen["workflow_id"], "run_x")

    async def test_refuses_before_the_runtime_is_ready(self):
        with patch.object(runs.durable_runtime, "is_ready", return_value=False):
            with self.assertRaises(RuntimeError):
                await runs.start_run("run_x", dict(_RUN_INPUT))


def _is_terminal(ev: dict) -> bool:
    return ev.get("status") in ("completed", "error")


if __name__ == "__main__":
    unittest.main()
