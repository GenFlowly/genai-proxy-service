"""
Unit tests for the content_reset event in stream_events_dicts.

Run with `python -m unittest tests.test_streaming_content_reset`.

A generation round that ends in in-graph (built-in) tool calls streams its
tokens live — but that text is a tool-call preamble ("Let me look up…"), not
the answer: the graph loops through TOOL_EXECUTOR and generates again.
content_reset tells accumulating consumers (the proxy's persistence buffer,
the client's visible text) to discard the round's content. It must fire ONLY
for in-graph rounds: caller-defined tool calls exit the turn, and their
accompanying text is the assistant content the caller must keep.

The graph is faked: stream_events_dicts only consumes `astream_events`, so a
stub yielding hand-built v2 events exercises the real routing logic without a
model or a compiled LangGraph.
"""
import unittest

from langchain_core.messages import AIMessage, AIMessageChunk

from streaming import stream_events_dicts, _stop_reason_of

_GEN = "GEN_NODE"


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


def _model_end_event(tool_calls: list, response_metadata: dict | None = None) -> dict:
    output = AIMessage(
        content="",
        tool_calls=[
            {"name": name, "args": {}, "id": f"id-{i}", "type": "tool_call"}
            for i, name in enumerate(tool_calls)
        ],
        response_metadata=response_metadata or {},
    )
    return {
        "event": "on_chat_model_end",
        "metadata": {"langgraph_node": _GEN},
        "data": {"output": output},
    }


async def _collect(events, builtin_tool_names=frozenset({"web_search"})):
    payloads = []
    async for payload in stream_events_dicts(
        {"llm_provider": "openai", "customer_id": "cust-1"},
        graph=_FakeGraph(events),
        streaming_nodes={_GEN},
        builtin_tool_names=set(builtin_tool_names),
    ):
        payloads.append(payload)
    return payloads


class ContentResetTests(unittest.IsolatedAsyncioTestCase):
    async def test_builtin_tool_round_emits_content_reset_after_the_preamble(self):
        payloads = await _collect([
            _stream_event("Let me look "),
            _stream_event("that up."),
            _model_end_event(["web_search"]),
        ])

        contents = [p["content"] for p in payloads if "content" in p]
        self.assertEqual(contents, ["Let me look ", "that up."])
        # The reset arrives after the preamble tokens, before any next round.
        reset_idx = payloads.index({"content_reset": True})
        last_content_idx = max(i for i, p in enumerate(payloads) if "content" in p)
        self.assertGreater(reset_idx, last_content_idx)

    async def test_caller_tool_round_keeps_its_text_and_emits_tool_calls(self):
        payloads = await _collect([
            _stream_event("Checking the tracker."),
            _model_end_event(["create_issue"]),
        ])

        self.assertNotIn({"content_reset": True}, payloads)
        tool_call_events = [p for p in payloads if "tool_calls" in p]
        self.assertEqual(len(tool_call_events), 1)
        self.assertEqual(tool_call_events[0]["tool_calls"][0]["name"], "create_issue")

    async def test_plain_answer_round_emits_neither(self):
        payloads = await _collect([
            _stream_event("The answer is 9."),
            _model_end_event([]),
        ])

        self.assertNotIn({"content_reset": True}, payloads)
        self.assertFalse(any("tool_calls" in p for p in payloads))
        self.assertIn({"content": "The answer is 9."}, payloads)

    async def test_two_rounds_reset_between_preamble_and_final_answer(self):
        payloads = await _collect([
            _stream_event("Let me search."),
            _model_end_event(["web_search"]),
            # …TOOL_EXECUTOR would run here…
            _stream_event("The answer is 9."),
            _model_end_event([]),
        ])

        reset_idx = payloads.index({"content_reset": True})
        preamble_idx = payloads.index({"content": "Let me search."})
        answer_idx = payloads.index({"content": "The answer is 9."})
        self.assertLess(preamble_idx, reset_idx)
        self.assertLess(reset_idx, answer_idx)


class StopReasonTests(unittest.IsolatedAsyncioTestCase):
    def test_reads_and_lowercases_either_vendor_field(self):
        from langchain_core.messages import AIMessage as _M
        # Anthropic uses stop_reason, OpenAI/Gemini use finish_reason.
        self.assertEqual(_stop_reason_of(_M(content="", response_metadata={"stop_reason": "refusal"})), "refusal")
        self.assertEqual(_stop_reason_of(_M(content="", response_metadata={"finish_reason": "SAFETY"})), "safety")
        self.assertEqual(_stop_reason_of(_M(content="", response_metadata={})), "")

    def test_the_responses_api_status_becomes_a_stop_reason(self):
        # gpt-5 models run on the OpenAI Responses API, which reports a status
        # and incomplete_details instead of a finish_reason.
        _M = AIMessage
        self.assertEqual(_stop_reason_of(_M(content="", response_metadata={"status": "completed"})), "stop")
        self.assertEqual(_stop_reason_of(_M(content="", response_metadata={
            "status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}})), "max_output_tokens")
        self.assertEqual(_stop_reason_of(_M(content="", response_metadata={
            "status": "incomplete", "incomplete_details": {"reason": "content_filter"}})), "content_filter")
        self.assertEqual(_stop_reason_of(_M(content="", response_metadata={"status": "incomplete"})), "incomplete")
        self.assertEqual(_stop_reason_of(_M(content="", response_metadata={"status": "failed"})), "failed")
        # A real finish reason always wins.
        self.assertEqual(_stop_reason_of(_M(content="", response_metadata={
            "finish_reason": "length", "status": "completed"})), "length")

    async def test_a_terminal_round_streams_its_raw_reason(self):
        # A refusal (empty content, no tool calls) must still surface its reason.
        payloads = await _collect([
            _model_end_event([], response_metadata={"stop_reason": "refusal"}),
        ])
        self.assertIn({"stop_reason": "refusal"}, payloads)

    async def test_a_plain_answer_streams_end_turn(self):
        payloads = await _collect([
            _stream_event("The answer is 9."),
            _model_end_event([], response_metadata={"stop_reason": "end_turn"}),
        ])
        self.assertIn({"stop_reason": "end_turn"}, payloads)
        # Ordering: the reason lands after the answer text it describes.
        self.assertGreater(
            payloads.index({"stop_reason": "end_turn"}),
            payloads.index({"content": "The answer is 9."}),
        )

    async def test_an_in_graph_tool_round_does_not_stream_a_stop_reason(self):
        # The web_search round continues in-graph — its "tool_use" reason is not
        # terminal, so it must not be surfaced; the next round carries the real one.
        payloads = await _collect([
            _stream_event("Let me search."),
            _model_end_event(["web_search"], response_metadata={"stop_reason": "tool_use"}),
        ])
        self.assertFalse(any("stop_reason" in p for p in payloads))
        # It's an in-graph round, so content_reset still fires.
        self.assertIn({"content_reset": True}, payloads)

    async def test_no_reason_metadata_emits_nothing(self):
        payloads = await _collect([
            _stream_event("hi"),
            _model_end_event([]),  # empty response_metadata
        ])
        self.assertFalse(any("stop_reason" in p for p in payloads))


if __name__ == "__main__":
    unittest.main()
