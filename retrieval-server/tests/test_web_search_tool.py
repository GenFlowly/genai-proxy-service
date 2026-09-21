"""Unit tests for the web_search built-in tool — no live Tavily call.

The HTTP call (WebSearchTool._search) is patched, so these exercise the pure
logic: payload assembly (topic/days/max_results), result formatting with
publish dates, and graceful degradation on a missing key or upstream failure.

Run with:
    .venv/bin/python -m unittest tests.test_web_search_tool
"""
import unittest
from unittest.mock import AsyncMock, patch

from graph_tools import default_registry
from graph_tools.base import ToolContext
from graph_tools.tools.web_search import WebSearchTool


def _ctx() -> ToolContext:
    # web_search never touches the artifact store, so a placeholder is fine.
    return ToolContext(customer_id="cust-1", store=object(), key_template="{artifact_id}")


_SAMPLE = {
    "results": [
        {
            "title": "Headline One",
            "url": "https://example.com/1",
            "content": "First snippet.",
            "published_date": "2026-09-20",
            "score": 0.9,
        },
        {
            "title": "Headline Two",
            "url": "https://example.com/2",
            "content": "Second snippet.",
            "score": 0.8,
        },
    ]
}


class WebSearchToolTest(unittest.IsolatedAsyncioTestCase):
    async def test_missing_api_key_degrades_gracefully(self):
        with patch.dict("os.environ", {}, clear=True):
            result = await WebSearchTool().run({"query": "anything"}, _ctx())
        self.assertIn("unavailable", result.content.lower())
        self.assertEqual(result.artifacts, [])

    async def test_empty_query_returns_error(self):
        with patch.dict("os.environ", {"TAVILY_API_KEY": "k"}):
            result = await WebSearchTool().run({"query": "   "}, _ctx())
        self.assertIn("empty", result.content.lower())

    async def test_formats_results_with_publish_dates(self):
        tool = WebSearchTool()
        with patch.dict("os.environ", {"TAVILY_API_KEY": "k"}), \
                patch.object(tool, "_search", AsyncMock(return_value=_SAMPLE)):
            result = await tool.run({"query": "latest news"}, _ctx())
        self.assertIn("Headline One", result.content)
        self.assertIn("https://example.com/1", result.content)
        self.assertIn("published 2026-09-20", result.content)  # date surfaced
        self.assertIn("[1]", result.content)
        self.assertIn("[2]", result.content)
        self.assertIn("cite", result.content.lower())

    async def test_news_topic_sets_days_and_clamps_max_results(self):
        tool = WebSearchTool()
        search = AsyncMock(return_value={"results": []})
        with patch.dict("os.environ", {"TAVILY_API_KEY": "k"}), \
                patch.object(tool, "_search", search):
            await tool.run(
                {"query": "election", "topic": "news", "max_results": 99}, _ctx()
            )
        payload = search.await_args.args[0]
        self.assertEqual(payload["topic"], "news")
        self.assertEqual(payload["days"], 7)  # default news window
        self.assertEqual(payload["max_results"], 10)  # clamped to cap

    async def test_general_topic_omits_days(self):
        tool = WebSearchTool()
        search = AsyncMock(return_value={"results": []})
        with patch.dict("os.environ", {"TAVILY_API_KEY": "k"}), \
                patch.object(tool, "_search", search):
            await tool.run({"query": "photosynthesis", "topic": "general"}, _ctx())
        payload = search.await_args.args[0]
        self.assertEqual(payload["topic"], "general")
        self.assertNotIn("days", payload)

    async def test_invalid_topic_falls_back_to_general(self):
        tool = WebSearchTool()
        search = AsyncMock(return_value={"results": []})
        with patch.dict("os.environ", {"TAVILY_API_KEY": "k"}), \
                patch.object(tool, "_search", search):
            await tool.run({"query": "x", "topic": "bogus"}, _ctx())
        self.assertEqual(search.await_args.args[0]["topic"], "general")

    async def test_no_results_message(self):
        tool = WebSearchTool()
        with patch.dict("os.environ", {"TAVILY_API_KEY": "k"}), \
                patch.object(tool, "_search", AsyncMock(return_value={"results": []})):
            result = await tool.run({"query": "obscure"}, _ctx())
        self.assertIn("no web results", result.content.lower())

    async def test_search_failure_degrades_gracefully(self):
        tool = WebSearchTool()
        with patch.dict("os.environ", {"TAVILY_API_KEY": "k"}), \
                patch.object(tool, "_search", AsyncMock(side_effect=RuntimeError("boom"))):
            result = await tool.run({"query": "x"}, _ctx())
        self.assertIn("failed", result.content.lower())
        self.assertEqual(result.artifacts, [])

    def test_registered_in_default_registry(self):
        registry = default_registry()
        self.assertTrue(registry.has("web_search"))
        spec = next(s for s in registry.specs(["web_search"]))
        self.assertEqual(spec["name"], "web_search")
        self.assertIn("query", spec["parameters"]["properties"])
        self.assertEqual(spec["parameters"]["required"], ["query"])


if __name__ == "__main__":
    unittest.main()
