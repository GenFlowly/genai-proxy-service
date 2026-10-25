"""Unit tests for the web_search built-in tool — no live Tavily call.

The HTTP call (WebSearchTool._search) is patched, so these exercise the pure
logic: payload assembly (topic/days/max_results), result formatting with
publish dates, and graceful degradation on a missing key or upstream failure.

The API key comes exclusively from context.secrets (the customer's stored
credential) — there is no TAVILY_API_KEY environment fallback.

Run with:
    .venv/bin/python -m unittest tests.test_web_search_tool
"""
import unittest
from unittest.mock import AsyncMock, patch

from graph_tools import default_registry
from graph_tools.base import ToolContext
from graph_tools.tools.web_search import WebSearchTool


def _ctx(secrets: dict | None = None) -> ToolContext:
    # web_search never touches the artifact store, so a placeholder is fine.
    context = ToolContext(customer_id="cust-1", store=object(), key_template="{artifact_id}")
    if secrets is not None:
        context.secrets = lambda ref: secrets.get(ref, {})
    return context


def _keyed_ctx(key: str = "tvly-customer") -> ToolContext:
    return _ctx({"WEB_SEARCH": {"api_key": key}})


class _StatusError(Exception):
    """Stands in for httpx.HTTPStatusError: the tool only reads
    e.response.status_code, so any exception with that shape exercises the
    status-specific degrade paths."""

    def __init__(self, status_code: int):
        super().__init__(f"Client error '{status_code}'")
        self.response = type("R", (), {"status_code": status_code})()


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
        result = await WebSearchTool().run({"query": "anything"}, _ctx())
        self.assertIn("unavailable", result.content.lower())
        self.assertEqual(result.artifacts, [])
        self.assertEqual(result.sources, [])

    async def test_empty_query_returns_error(self):
        result = await WebSearchTool().run({"query": "   "}, _keyed_ctx())
        self.assertIn("empty", result.content.lower())

    async def test_returns_structured_sources_with_publish_dates(self):
        # The tool surfaces structured Source objects; the HOST numbers, renders
        # and cites them (see tool_executor), so the tool must NOT number its own.
        tool = WebSearchTool()
        with patch.object(tool, "_search", AsyncMock(return_value=_SAMPLE)):
            result = await tool.run({"query": "latest news"}, _keyed_ctx())
        self.assertEqual(len(result.sources), 2)
        first = result.sources[0]
        self.assertEqual(first.title, "Headline One")
        self.assertEqual(first.url, "https://example.com/1")
        self.assertEqual(first.content, "First snippet.")
        self.assertEqual(first.published_date, "2026-09-20")  # date surfaced
        self.assertEqual(result.sources[1].published_date, "")  # absent → blank
        # content is a bare preamble — no hand-numbered list, no [1]/[2].
        self.assertNotIn("[1]", result.content)
        self.assertIn("latest news", result.content)

    async def test_domain_scoping_is_passed_to_tavily_and_normalized(self):
        tool = WebSearchTool()
        search = AsyncMock(return_value={"results": []})
        with patch.object(tool, "_search", search):
            await tool.run(
                {
                    "query": "x",
                    # A stray 'site:' / scheme / trailing slash the model may add
                    # is stripped so Tavily gets a bare domain.
                    "include_domains": ["site:docs.anthropic.com/", "https://github.com"],
                    "exclude_domains": ["reddit.com"],
                },
                _keyed_ctx(),
            )
        payload = search.await_args.args[0]
        self.assertEqual(payload["include_domains"], ["docs.anthropic.com", "github.com"])
        self.assertEqual(payload["exclude_domains"], ["reddit.com"])

    async def test_domain_scoping_omitted_when_absent(self):
        tool = WebSearchTool()
        search = AsyncMock(return_value={"results": []})
        with patch.object(tool, "_search", search):
            await tool.run({"query": "x"}, _keyed_ctx())
        payload = search.await_args.args[0]
        self.assertNotIn("include_domains", payload)
        self.assertNotIn("exclude_domains", payload)

    async def test_news_topic_sets_days_and_clamps_max_results(self):
        tool = WebSearchTool()
        search = AsyncMock(return_value={"results": []})
        with patch.object(tool, "_search", search):
            await tool.run(
                {"query": "election", "topic": "news", "max_results": 99}, _keyed_ctx()
            )
        payload = search.await_args.args[0]
        self.assertEqual(payload["topic"], "news")
        self.assertEqual(payload["days"], 7)  # default news window
        self.assertEqual(payload["max_results"], 5)  # clamped to cap

    async def test_general_topic_omits_days(self):
        tool = WebSearchTool()
        search = AsyncMock(return_value={"results": []})
        with patch.object(tool, "_search", search):
            await tool.run({"query": "photosynthesis", "topic": "general"}, _keyed_ctx())
        payload = search.await_args.args[0]
        self.assertEqual(payload["topic"], "general")
        self.assertNotIn("days", payload)

    async def test_invalid_topic_falls_back_to_general(self):
        tool = WebSearchTool()
        search = AsyncMock(return_value={"results": []})
        with patch.object(tool, "_search", search):
            await tool.run({"query": "x", "topic": "bogus"}, _keyed_ctx())
        self.assertEqual(search.await_args.args[0]["topic"], "general")

    async def test_search_depth_defaults_to_basic(self):
        tool = WebSearchTool()
        search = AsyncMock(return_value={"results": []})
        with patch.object(tool, "_search", search):
            await tool.run({"query": "x"}, _keyed_ctx())
        self.assertEqual(search.await_args.args[0]["search_depth"], "basic")

    async def test_search_depth_advanced_passes_through(self):
        tool = WebSearchTool()
        search = AsyncMock(return_value={"results": []})
        with patch.object(tool, "_search", search):
            await tool.run({"query": "x", "search_depth": "advanced"}, _keyed_ctx())
        self.assertEqual(search.await_args.args[0]["search_depth"], "advanced")

    async def test_invalid_search_depth_falls_back_to_basic(self):
        tool = WebSearchTool()
        search = AsyncMock(return_value={"results": []})
        with patch.object(tool, "_search", search):
            await tool.run({"query": "x", "search_depth": "bogus"}, _keyed_ctx())
        self.assertEqual(search.await_args.args[0]["search_depth"], "basic")

    async def test_records_usage_with_depth_and_credits_after_a_successful_search(self):
        tool = WebSearchTool()
        with patch.object(tool, "_search", AsyncMock(return_value={"results": []})), \
             patch("encoding_library.utils.usage_tracking.record_web_search_usage") as mock_record:
            await tool.run({"query": "x", "search_depth": "advanced"}, _keyed_ctx())
        mock_record.assert_called_once_with("cust-1", "advanced", 2)

    async def test_does_not_record_usage_when_the_search_call_fails(self):
        tool = WebSearchTool()
        with patch.object(tool, "_search", AsyncMock(side_effect=RuntimeError("boom"))), \
             patch("encoding_library.utils.usage_tracking.record_web_search_usage") as mock_record:
            await tool.run({"query": "x"}, _keyed_ctx())
        mock_record.assert_not_called()

    async def test_no_results_message(self):
        tool = WebSearchTool()
        with patch.object(tool, "_search", AsyncMock(return_value={"results": []})):
            result = await tool.run({"query": "obscure"}, _keyed_ctx())
        self.assertIn("no web results", result.content.lower())

    async def test_search_failure_degrades_gracefully(self):
        tool = WebSearchTool()
        with patch.object(tool, "_search", AsyncMock(side_effect=RuntimeError("boom"))):
            result = await tool.run({"query": "x"}, _keyed_ctx())
        self.assertIn("failed", result.content.lower())
        self.assertEqual(result.artifacts, [])

    async def test_quota_exhaustion_is_terminal(self):
        # Tavily 432/433 are account-level quota limits: retrying cannot succeed,
        # so the message must say so (not invite another attempt).
        tool = WebSearchTool()
        error = _StatusError(432)
        with patch.object(tool, "_search", AsyncMock(side_effect=error)):
            result = await tool.run({"query": "x"}, _keyed_ctx())
        self.assertIn("out of credits", result.content.lower())
        self.assertNotIn("try again", result.content.lower())

    async def test_invalid_key_is_terminal(self):
        tool = WebSearchTool()
        error = _StatusError(401)
        with patch.object(tool, "_search", AsyncMock(side_effect=error)):
            result = await tool.run({"query": "x"}, _keyed_ctx("bad"))
        self.assertIn("invalid", result.content.lower())
        self.assertNotIn("try again", result.content.lower())


class WebSearchCredentialTest(unittest.IsolatedAsyncioTestCase):
    """The customer's stored key is the ONLY key source — the tool must never
    read a platform-wide key from the environment."""

    async def test_declares_its_credential_ref(self):
        self.assertEqual(WebSearchTool().credential_ref, "WEB_SEARCH")

    async def test_customer_key_is_used_for_the_search(self):
        tool = WebSearchTool()
        search = AsyncMock(return_value=_SAMPLE)
        with patch.object(tool, "_search", search):
            result = await tool.run({"query": "x"}, _keyed_ctx("tvly-customer"))

        self.assertEqual(search.await_args.args[1], "tvly-customer")
        self.assertNotIn("unavailable", result.content.lower())

    async def test_env_var_is_ignored_when_no_customer_key(self):
        with patch.dict("os.environ", {"TAVILY_API_KEY": "tvly-platform"}):
            result = await WebSearchTool().run({"query": "x"}, _ctx({}))

        self.assertIn("unavailable", result.content.lower())

    async def test_blank_customer_key_degrades_gracefully(self):
        ctx = _ctx({"WEB_SEARCH": {"api_key": ""}})
        with patch.dict("os.environ", {"TAVILY_API_KEY": "tvly-platform"}):
            result = await WebSearchTool().run({"query": "x"}, ctx)

        self.assertIn("unavailable", result.content.lower())

    async def test_a_context_without_injected_secrets_degrades_gracefully(self):
        # ToolContext.secrets defaults to "no credentials", so a host that has
        # not wired resolution yet gets the unavailable message, not a crash.
        with patch.dict("os.environ", {"TAVILY_API_KEY": "tvly-platform"}):
            result = await WebSearchTool().run({"query": "x"}, _ctx())

        self.assertIn("unavailable", result.content.lower())


class WebSearchRegistrationTest(unittest.TestCase):
    def test_registered_in_default_registry(self):
        registry = default_registry()
        self.assertTrue(registry.has("web_search"))
        spec = next(s for s in registry.specs(["web_search"]))
        self.assertEqual(spec["name"], "web_search")
        self.assertIn("query", spec["parameters"]["properties"])
        self.assertEqual(spec["parameters"]["required"], ["query"])
        # Deliberately unadvertised — models asked for the cap whenever the
        # schema offered one (run() still clamps a value passed anyway).
        self.assertNotIn("max_results", spec["parameters"]["properties"])


if __name__ == "__main__":
    unittest.main()
