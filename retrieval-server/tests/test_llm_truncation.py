"""
Unit tests for the truncated/malformed tool-call guard (plan 1.8).

Run with `python -m unittest tests.test_llm_truncation`.

On the streaming paths LangChain's parse_partial_json turns a tool call that
was cut off at the output limit into a VALID one, so a generate_pdf call whose
document was cut mid-way rendered a truncated PDF and reported success. A
response that ended at the output limit (or carries invalid_tool_calls) must
therefore never have its calls executed or forwarded:
- built-in calls stay in state, marked truncated with args emptied, for the
  executor to answer with a NOT-executed result;
- caller-defined calls are dropped, and stop_reason says why.
"""
import unittest
from unittest.mock import patch

from langchain_core.messages import AIMessage, AIMessageChunk

import graph.nodes.llm_node as llm_node_module
from graph import truncation
from graph.nodes.llm_node import make_llm_node
from streaming import _ToolArgProgress, stream_events_dicts
from tests.test_llm_node_prompt import _state
from tests.test_streaming_content_reset import _GEN, _FakeGraph, _stream_event

_DOC = "# Report\n\n" + "A sentence of the report. " * 40

# Vendor-shaped endings. Responses API messages (status/incomplete_details)
# carry no stop or finish reason at all.
_CUT_OFF = {
    "anthropic": {"stop_reason": "max_tokens"},
    "openai_chat": {"finish_reason": "length"},
    "gemini": {"finish_reason": "MAX_TOKENS"},
    "openai_responses": {"status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}},
}
_NORMAL = {
    "anthropic": {"stop_reason": "tool_use"},
    "openai_chat": {"finish_reason": "tool_calls"},
    "gemini": {"finish_reason": "STOP"},
    "openai_responses": {"status": "completed"},
}


def _call(name: str, args: dict | None = None, call_id: str = "call-1") -> dict:
    return {"name": name, "args": args if args is not None else {"q": "x"}, "id": call_id, "type": "tool_call"}


def _message(calls: list, metadata: dict, invalid: list | None = None) -> AIMessage:
    return AIMessage(content="", tool_calls=calls, invalid_tool_calls=invalid or [],
                     response_metadata=metadata)


class TruncationReasonTests(unittest.TestCase):
    def test_cut_off_endings_of_every_vendor(self):
        expected = {
            "anthropic": "max_tokens",
            "openai_chat": "length",
            "gemini": "max_tokens",
            "openai_responses": "max_output_tokens",
        }
        for vendor, metadata in _CUT_OFF.items():
            with self.subTest(vendor=vendor):
                message = _message([], metadata)
                self.assertEqual(truncation.cut_off_reason(message), expected[vendor])
                self.assertEqual(truncation.truncation_reason(message), expected[vendor])

    def test_normal_endings_are_not_cut_off(self):
        for vendor, metadata in _NORMAL.items():
            with self.subTest(vendor=vendor):
                self.assertIsNone(truncation.truncation_reason(_message([_call("t")], metadata)))

    def test_invalid_tool_calls_are_malformed(self):
        message = _message([], _NORMAL["anthropic"], invalid=[{
            "name": "generate_pdf", "args": '{"content_markdown": "abc', "id": "c1",
            "error": "bad json", "type": "invalid_tool_call",
        }])
        self.assertIsNone(truncation.cut_off_reason(message))
        self.assertEqual(truncation.truncation_reason(message), "invalid_tool_call")

    def test_stop_reason_of_reads_the_responses_api_status(self):
        self.assertEqual(truncation.stop_reason_of(_message([], _CUT_OFF["openai_responses"])),
                         "max_output_tokens")
        self.assertEqual(truncation.stop_reason_of(_message([], _CUT_OFF["gemini"])), "max_tokens")
        self.assertEqual(truncation.stop_reason_of(_message([], {})), "")

    def test_refusal_texts(self):
        self.assertIn("NOT executed", truncation.refusal_text("max_tokens"))
        self.assertNotIn("fs_write", truncation.refusal_text("max_tokens"))
        self.assertIn("fs_write", truncation.refusal_text("length", fs_write_enabled=True))
        self.assertIn("not valid JSON", truncation.refusal_text("invalid_tool_call"))


class _ReplyLLM:
    def __init__(self, reply: AIMessage):
        self.reply = reply

    async def ainvoke(self, messages):
        return self.reply


async def _run_node(reply: AIMessage, **state_overrides) -> dict:
    tools = [{"name": "create_issue", "description": "Create an issue",
              "parameters": {"type": "object", "properties": {"q": {"type": "string"}}}}]
    state = _state(builtin_tools=["generate_pdf"], tools=tools, **state_overrides)
    with patch.object(llm_node_module, "_build_llm_and_structured", return_value=(_ReplyLLM(reply), None)), \
            patch.object(llm_node_module, "credentials_for", return_value={}):
        return await make_llm_node("RESPONSE_GENERATOR")(state)


class LlmNodeGuardTests(unittest.IsolatedAsyncioTestCase):
    async def test_cut_off_builtin_calls_are_kept_truncated_and_caller_calls_dropped(self):
        for vendor, metadata in _CUT_OFF.items():
            with self.subTest(vendor=vendor):
                reply = _message([
                    _call("generate_pdf", {"content_markdown": _DOC, "filename": "r.pdf"}, "c1"),
                    _call("create_issue", {"q": "x"}, "c2"),
                ], metadata)
                result = await _run_node(reply)
                self.assertEqual(result["stop_reason"], truncation.cut_off_reason(reply))
                self.assertEqual(result["tool_calls"], [{
                    "id": "c1", "name": "generate_pdf", "args": {},
                    "truncated": True, "truncation_reason": truncation.cut_off_reason(reply),
                }])

    async def test_cut_off_with_only_caller_calls_forwards_nothing(self):
        result = await _run_node(_message([_call("create_issue")], _CUT_OFF["anthropic"]))
        self.assertEqual(result["stop_reason"], "max_tokens")
        self.assertNotIn("tool_calls", result)

    async def test_malformed_builtin_call_is_kept_for_refusal_and_valid_ones_run(self):
        reply = _message(
            [_call("generate_pdf", {"content_markdown": "ok", "filename": "a.pdf"}, "c1"),
             _call("create_issue", {"q": "y"}, "c2")],
            _NORMAL["anthropic"],
            invalid=[{"name": "generate_pdf", "args": '{"content_markdown": "ab', "id": "c3",
                      "error": "bad json", "type": "invalid_tool_call"}],
        )
        result = await _run_node(reply)
        self.assertEqual(result["stop_reason"], "invalid_tool_call")
        self.assertEqual(result["tool_calls"], [
            {"id": "c1", "name": "generate_pdf", "args": {"content_markdown": "ok", "filename": "a.pdf"}},
            {"id": "c3", "name": "generate_pdf", "args": {}, "truncated": True,
             "truncation_reason": "invalid_tool_call"},
        ])

    async def test_normal_responses_are_untouched(self):
        reply = _message([_call("create_issue", {"q": "z"}, "c9")], _NORMAL["openai_chat"])
        result = await _run_node(reply)
        self.assertIsNone(result["stop_reason"])
        self.assertEqual(result["tool_calls"], [{"id": "c9", "name": "create_issue", "args": {"q": "z"}}])

    async def test_metrics_count_each_refused_call_once(self):
        calls = []
        with patch.object(llm_node_module, "record_truncated", side_effect=lambda t, r: calls.append((t, r))):
            await _run_node(_message(
                [_call("generate_pdf", {}, "c1"), _call("create_issue", {}, "c2")],
                _CUT_OFF["openai_chat"],
                invalid=[{"name": "generate_pdf", "args": "{", "id": "c3", "error": "x",
                          "type": "invalid_tool_call"}],
            ))
        self.assertEqual(sorted(calls), [("create_issue", "length"), ("generate_pdf", "length"),
                                         ("generate_pdf", "length")])


def _end_event(calls: list, metadata: dict) -> dict:
    return {
        "event": "on_chat_model_end",
        "metadata": {"langgraph_node": _GEN},
        "data": {"output": _message(calls, metadata)},
    }


async def _collect(events, builtin=frozenset({"generate_pdf"})):
    out = []
    async for payload in stream_events_dicts(
        {"llm_provider": "anthropic", "customer_id": "cust-1"},
        graph=_FakeGraph(events),
        streaming_nodes={_GEN},
        builtin_tool_names=set(builtin),
    ):
        out.append(payload)
    return out


class StreamingGuardTests(unittest.IsolatedAsyncioTestCase):
    async def test_cut_off_caller_calls_are_withheld_with_a_stop_reason(self):
        payloads = await _collect([
            _stream_event("Here it comes."),
            _end_event([_call("create_issue", {"q": "partial"})], _CUT_OFF["anthropic"]),
        ])
        self.assertIn({"stop_reason": "max_tokens"}, payloads)
        self.assertFalse([p for p in payloads if p.get("tool_calls")])

    async def test_responses_api_cut_off_is_detected_too(self):
        payloads = await _collect([
            _end_event([_call("create_issue")], _CUT_OFF["openai_responses"]),
        ])
        self.assertIn({"stop_reason": "max_output_tokens"}, payloads)
        self.assertFalse([p for p in payloads if p.get("tool_calls")])

    async def test_normal_caller_calls_are_still_forwarded(self):
        payloads = await _collect([_end_event([_call("create_issue")], _NORMAL["anthropic"])])
        forwarded = [p for p in payloads if p.get("tool_calls")]
        self.assertEqual(len(forwarded), 1)
        self.assertEqual(forwarded[0]["tool_calls"][0]["name"], "create_issue")


class ProgressTests(unittest.TestCase):
    def _chunk(self, name=None, args="", index=0):
        return AIMessageChunk(content="", tool_call_chunks=[
            {"name": name, "args": args, "id": None, "index": index, "type": "tool_call_chunk"},
        ])

    def test_reports_document_tools_at_most_every_interval(self):
        now = [100.0]
        progress = _ToolArgProgress(clock=lambda: now[0])
        self.assertEqual(progress.update(self._chunk("generate_pdf", '{"content_')),
                         {"tool": "generate_pdf", "chars": 10})
        now[0] += 1
        self.assertIsNone(progress.update(self._chunk(args="x" * 100)))
        now[0] += 5
        self.assertEqual(progress.update(self._chunk(args="y" * 10)),
                         {"tool": "generate_pdf", "chars": 120})

    def test_other_tools_and_text_are_not_reported(self):
        progress = _ToolArgProgress(clock=lambda: 1000.0)
        self.assertIsNone(progress.update(self._chunk("web_search", '{"query": "x"}')))
        self.assertIsNone(progress.update(AIMessageChunk(content="hello")))

    def test_stream_emits_progress_frames(self):
        import asyncio

        async def go():
            chunk = {
                "event": "on_chat_model_stream",
                "metadata": {"langgraph_node": _GEN},
                "data": {"chunk": self._chunk("fs_write", '{"path": "a.md", "content": "abc')},
            }
            return await _collect([chunk])

        payloads = asyncio.run(go())
        self.assertIn({"progress": {"tool": "fs_write", "chars": 32}}, payloads)


if __name__ == "__main__":
    unittest.main()
