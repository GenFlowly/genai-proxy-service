"""
Unit tests for stream_events_dicts' should_stop handling (client disconnect).

A user Stop reaches the retrieval-server as the proxy dropping the /retrieve
connection. stream_events_dicts polls should_stop (request.is_disconnected on
that path) between graph events and, once it reports True, closes the graph's
event stream so no FURTHER step — LLM round, web search, vector lookup — runs.
The step already executing is allowed to finish; only future work is skipped.

The graph is faked (stream_events_dicts only consumes astream_events), and the
poll throttle is zeroed so the check runs on every event.
"""
import unittest
from unittest.mock import patch

from langchain_core.messages import AIMessageChunk

import streaming
from streaming import stream_events_dicts

_GEN = "GEN_NODE"


def _stream_event(text: str) -> dict:
    return {
        "event": "on_chat_model_stream",
        "metadata": {"langgraph_node": _GEN},
        "data": {"chunk": AIMessageChunk(content=text)},
    }


class _FakeGraph:
    """Yields its events one by one, recording consumption and aclose()."""

    def __init__(self, events):
        self._events = events
        self.consumed = 0
        self.closed = False

    async def astream_events(self, state, config=None, version=None):
        try:
            for event in self._events:
                self.consumed += 1
                yield event
        finally:
            self.closed = True


class ClientDisconnectTests(unittest.IsolatedAsyncioTestCase):
    async def _collect(self, graph, should_stop):
        payloads = []
        with patch.object(streaming, "_STOP_CHECK_INTERVAL_SECONDS", 0.0):
            async for payload in stream_events_dicts(
                {"llm_provider": "openai", "customer_id": "cust-1"},
                graph=graph,
                streaming_nodes={_GEN},
                should_stop=should_stop,
            ):
                payloads.append(payload)
        return payloads

    async def test_disconnect_stops_before_remaining_events(self):
        graph = _FakeGraph([_stream_event(t) for t in ("one", "two", "three", "four")])
        calls = 0

        async def disconnected_after_two() -> bool:
            nonlocal calls
            calls += 1
            return calls > 2

        payloads = await self._collect(graph, disconnected_after_two)

        contents = [p["content"] for p in payloads if "content" in p]
        self.assertEqual(contents, ["one", "two"])
        # The graph generator was closed early — the remaining events never ran.
        self.assertTrue(graph.closed)
        self.assertLess(graph.consumed, 4)
        # Early abort: no end-of-turn usage event (the client is gone anyway).
        self.assertNotIn("usage", [k for p in payloads for k in p])

    async def test_connected_client_streams_to_completion(self):
        graph = _FakeGraph([_stream_event(t) for t in ("one", "two")])

        async def still_connected() -> bool:
            return False

        payloads = await self._collect(graph, still_connected)

        contents = [p["content"] for p in payloads if "content" in p]
        self.assertEqual(contents, ["one", "two"])
        self.assertEqual(graph.consumed, 2)
        # Normal completion still emits the end-of-turn usage event.
        self.assertIn("usage", [k for p in payloads for k in p])

    async def test_no_should_stop_keeps_legacy_behavior(self):
        graph = _FakeGraph([_stream_event("one")])
        payloads = []
        async for payload in stream_events_dicts(
            {"llm_provider": "openai", "customer_id": "cust-1"},
            graph=graph,
            streaming_nodes={_GEN},
        ):
            payloads.append(payload)
        self.assertEqual([p["content"] for p in payloads if "content" in p], ["one"])


if __name__ == "__main__":
    unittest.main()
