"""
Unit tests for the thinking-panel payload streaming.py builds from a
completed node's state update (_step_done_payload) — the SSE "ks" event shape
the frontend renders live and that gets persisted into thinkingStepsJson.

Run with `python -m unittest tests.test_streaming_thinking_step`.

Pure-function coverage: no graph, no LLM, no HTTP — just node_type + a state
update dict in, a payload dict out.
"""
import unittest

from streaming import _fmt_tool_call, _step_done_payload


class FmtToolCallTests(unittest.TestCase):
    def test_no_args_renders_bare_name(self):
        self.assertEqual(_fmt_tool_call({"name": "web_search"}), "web_search")
        self.assertEqual(_fmt_tool_call({"name": "web_search", "args": {}}), "web_search")

    def test_string_args_are_quoted(self):
        call = {"name": "web_search", "args": {"query": "MGM Resorts", "topic": "news"}}
        self.assertEqual(_fmt_tool_call(call), 'web_search(query="MGM Resorts", topic="news")')

    def test_non_string_args_render_unquoted(self):
        call = {"name": "web_search", "args": {"max_results": 10}}
        self.assertEqual(_fmt_tool_call(call), "web_search(max_results=10)")

    def test_long_values_are_shown_in_full(self):
        # A truncated query defeats the purpose of showing it — the whole
        # point is letting someone read exactly what was searched for.
        query = "x" * 200
        call = {"name": "web_search", "args": {"query": query}}
        rendered = _fmt_tool_call(call)
        self.assertIn(query, rendered)
        self.assertNotIn("...", rendered)


class WebSearchNodeTests(unittest.TestCase):
    """The static WEB_SEARCH graph node's done payload."""

    def test_items_stay_capped_and_title_only_for_back_compat(self):
        results = [{"title": f"T{i}", "url": f"https://u{i}"} for i in range(1, 8)]
        payload = _step_done_payload("WEB_SEARCH", {"web_search_results": results})

        self.assertEqual(payload["detail"], "Found 7 web result(s)")
        self.assertEqual(len(payload["items"]), 5)
        self.assertEqual(payload["items"][0], "T1")

    def test_sources_are_the_full_untruncated_indexed_list(self):
        results = [{"title": f"T{i}", "url": f"https://u{i}"} for i in range(1, 8)]
        payload = _step_done_payload("WEB_SEARCH", {"web_search_results": results})

        self.assertEqual(len(payload["sources"]), 7)
        self.assertEqual(payload["sources"][0], {"index": 1, "title": "T1", "url": "https://u1"})
        self.assertEqual(payload["sources"][6], {"index": 7, "title": "T7", "url": "https://u7"})


class ToolExecutorNodeTests(unittest.TestCase):
    """The TOOL kind (TOOL_EXECUTOR node) done payload."""

    def test_calls_come_from_the_trace_entry(self):
        calls = [
            {"name": "web_search", "args": {"query": "a"}, "sources": [], "error": None},
            {"name": "web_search", "args": {"query": "b"}, "sources": [], "error": None},
        ]
        output = {
            "generated_artifacts": [],
            "tool_sources": [],
            "trace": [{"node": "TOOL_EXECUTOR", "prompt": "web_search, web_search",
                       "response": "...", "calls": calls}],
        }
        payload = _step_done_payload("TOOL_EXECUTOR", output)

        self.assertEqual(payload["detail"], "Executed 2 tool(s)")
        self.assertEqual(payload["calls"], calls)

    def test_missing_calls_key_falls_back_to_empty_list(self):
        # A trace entry predating this field (or a malformed one) must not crash.
        output = {"trace": [{"node": "TOOL_EXECUTOR", "prompt": "x", "response": "y"}]}
        payload = _step_done_payload("TOOL_EXECUTOR", output)

        self.assertEqual(payload["calls"], [])
        self.assertEqual(payload["detail"], "Executed 0 tool(s)")

    def test_back_compat_items_still_built_from_artifacts_and_sources(self):
        output = {
            "generated_artifacts": [{"filename": "report.pdf"}],
            "tool_sources": [{"index": 1, "title": "T1", "url": "u1"}],
            "trace": [{"node": "TOOL_EXECUTOR", "prompt": "x", "response": "y", "calls": []}],
        }
        payload = _step_done_payload("TOOL_EXECUTOR", output)

        self.assertIn("report.pdf", payload["items"])
        self.assertIn("T1", payload["items"])


class GeneratorToolCallTests(unittest.TestCase):
    """The LLM (response-generator) node's done payload when the model calls tools."""

    def test_reasoning_is_surfaced_when_the_model_wrote_any(self):
        output = {
            "generated_response": "Let me check the current numbers.",
            "tool_calls": [{"id": "1", "name": "web_search", "args": {"query": "x"}}],
        }
        payload = _step_done_payload("RESPONSE_GENERATOR", output)

        self.assertEqual(payload["reasoning"], "Let me check the current numbers.")
        self.assertEqual(payload["tool_calls"], [{"name": "web_search", "args": {"query": "x"}}])
        self.assertEqual(payload["detail"], 'Calling tools: web_search(query="x")')

    def test_no_reasoning_key_when_the_model_wrote_no_text(self):
        output = {
            "generated_response": "",
            "tool_calls": [{"id": "1", "name": "web_search", "args": {}}],
        }
        payload = _step_done_payload("RESPONSE_GENERATOR", output)

        self.assertNotIn("reasoning", payload)
        self.assertEqual(payload["detail"], "Calling tools: web_search")

    def test_multiple_calls_all_appear_in_the_structured_field(self):
        output = {
            "tool_calls": [
                {"id": "1", "name": "web_search", "args": {"query": "a"}},
                {"id": "2", "name": "web_search", "args": {"query": "b"}},
                {"id": "3", "name": "web_search", "args": {"query": "c"}},
            ],
        }
        payload = _step_done_payload("RESPONSE_GENERATOR", output)

        self.assertEqual(len(payload["tool_calls"]), 3)
        self.assertEqual(
            payload["detail"],
            'Calling tools: web_search(query="a"), web_search(query="b"), web_search(query="c")',
        )


if __name__ == "__main__":
    unittest.main()
