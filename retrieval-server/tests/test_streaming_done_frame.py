"""
Unit tests for stream_response's `[DONE]` framing.

Run with `python -m unittest tests.test_streaming_done_frame`.

The `[DONE]` sentinel must close every stream the client is still reading —
normal completion and mid-stream errors alike — but when the client has
disconnected, Starlette calls aclose() on the generator and any yield during
the resulting GeneratorExit raises RuntimeError("async generator ignored
GeneratorExit"), deferring cleanup of the inner generators to GC. So: [DONE]
on completion and on error, nothing on disconnect.

Tests 2 and 3 stub stream_events_dicts directly to control the inner
generator; test 1 runs the real pipeline over a fake graph (the same
stub-graph trick as test_streaming_content_reset).
"""
import unittest
from unittest.mock import patch

from langchain_core.messages import AIMessage, AIMessageChunk

from streaming import stream_response

_GEN = "GEN_NODE"

_DONE_FRAME = "data: [DONE]\n\n"


class _FakeGraph:
    def __init__(self, events):
        self._events = events

    async def astream_events(self, state, config=None, version=None):
        for event in self._events:
            yield event


def _stream_event(text: str) -> dict:
    return {
        "event": "on_chat_model_stream",
        "metadata": {"langgraph_node": _GEN},
        "data": {"chunk": AIMessageChunk(content=text)},
    }


def _model_end_event() -> dict:
    return {
        "event": "on_chat_model_end",
        "metadata": {"langgraph_node": _GEN},
        "data": {"output": AIMessage(content="")},
    }


class DoneFrameTests(unittest.IsolatedAsyncioTestCase):
    async def test_normal_completion_ends_with_done(self):
        frames = []
        async for frame in stream_response(
            {"llm_provider": "openai", "customer_id": "cust-1"},
            graph=_FakeGraph([_stream_event("The answer is 9."), _model_end_event()]),
            streaming_nodes={_GEN},
        ):
            frames.append(frame)

        self.assertEqual(frames[-1], _DONE_FRAME)
        self.assertEqual(frames.count(_DONE_FRAME), 1)
        self.assertIn('data: {"content": "The answer is 9."}\n\n', frames)

    async def test_client_disconnect_closes_cleanly_without_done(self):
        async def inner(*args, **kwargs):
            yield {"content": "one"}
            yield {"content": "two"}

        with patch("streaming.stream_events_dicts", inner):
            gen = stream_response({}, graph=object())
            frames = [await gen.__anext__()]
            await gen.aclose()

        self.assertEqual(frames, ['data: {"content": "one"}\n\n'])
        self.assertNotIn(_DONE_FRAME, frames)

    async def test_inner_exception_reraises_after_done(self):
        async def inner(*args, **kwargs):
            yield {"content": "partial"}
            raise ValueError("boom")

        frames = []
        with patch("streaming.stream_events_dicts", inner):
            with self.assertRaises(ValueError):
                async for frame in stream_response({}, graph=object()):
                    frames.append(frame)

        self.assertEqual(frames, ['data: {"content": "partial"}\n\n', _DONE_FRAME])


if __name__ == "__main__":
    unittest.main()
