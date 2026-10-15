"""
Unit tests for the durable-run workflow body (runs._run_agent_graph) and the
RunRequest→RetrieveRequest mapping — no live DB, no DBOS, no LLM.

The graph, checkpointer and run_events channel are faked, so this exercises the
pure orchestration logic: event fan-out to the channel, the terminal status
event, credentials left unset (resolved from DDB downstream), and the summary
read from the checkpointed final state. Run with:
    .venv/bin/python -m unittest tests.test_runs
"""
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
    async def _run(self, resolve):
        published = []

        async def fake_publish(run_id, event, terminal=False):
            published.append((run_id, event, terminal))
            return len(published)

        with patch.object(runs, "_resolve_durable_graph", resolve), \
             patch.object(runs.durable_runtime, "get_checkpointer", lambda: object()), \
             patch.object(run_events, "publish", fake_publish):
            summary = await runs._run_agent_graph("run_x", dict(_RUN_INPUT))
        return summary, published

    async def test_happy_path_streams_and_summarizes(self):
        summary, published = await self._run(_fake_resolve)

        kinds = [next(iter(ev)) for _, ev, _ in published if not _is_terminal(ev)]
        # thinking_step, content, usage streamed before the terminal event
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

    async def test_graph_error_becomes_error_status(self):
        summary, published = await self._run(_fake_resolve_boom)

        # stream_events_dicts converts the raised error into an {'error': …} event
        self.assertTrue(any("error" in ev and ev.get("error") for _, ev, term in published if not term))
        terminals = [ev for _, ev, term in published if term]
        self.assertEqual(len(terminals), 1)
        self.assertEqual(terminals[0]["status"], "error")
        self.assertTrue(summary["error"])


class NodeErrorSummaryTest(unittest.IsolatedAsyncioTestCase):
    """A node-level error (e.g. a failed retrieval) that still produced an
    answer is a completed turn with a warning: the proxy reads status "error"
    or an "error" text as a failed turn (contract C5)."""

    async def _summary(self, values):
        class _Snap:
            pass

        snap = _Snap()
        snap.values = {**_FakeSnap.values, **values}

        class _Graph(_FakeGraph):
            async def aget_state(self, config):
                return snap

        def resolve(customer_id, graph_id, checkpointer):
            return _Graph(), {"n": "RESPONSE_GENERATOR"}, {"n": "Gen"}, {"n": {}}, {"n"}, 10

        published = []

        async def fake_publish(run_id, event, terminal=False):
            published.append((event, terminal))
            return len(published)

        with patch.object(runs, "_resolve_durable_graph", resolve), \
             patch.object(runs.durable_runtime, "get_checkpointer", lambda: object()), \
             patch.object(run_events, "publish", fake_publish):
            await runs._run_agent_graph("run_x", dict(_RUN_INPUT))
        return next(ev for ev, terminal in published if terminal)

    async def test_an_answer_with_a_node_error_is_completed_with_a_warning(self):
        terminal = await self._summary({"error": "retrieval failed", "generated_response": "Answer"})
        self.assertEqual(terminal["status"], "completed")
        self.assertIsNone(terminal["error"])
        self.assertEqual(terminal["warning"], "retrieval failed")

    async def test_a_node_error_without_an_answer_fails_the_turn(self):
        terminal = await self._summary({"error": "retrieval failed", "generated_response": None})
        self.assertEqual(terminal["status"], "error")
        self.assertEqual(terminal["error"], "retrieval failed")


def _is_terminal(ev: dict) -> bool:
    return ev.get("status") in ("completed", "error")


if __name__ == "__main__":
    unittest.main()
