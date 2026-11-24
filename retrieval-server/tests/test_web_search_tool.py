"""Unit tests for the web_search built-in tool — no live Tavily call.

The HTTP call (WebSearchTool._search) is patched — or, where Tavily's error
body matters, run against a stub httpx transport — so these exercise the pure
logic: payload assembly (topic/days/max_results), result formatting with
publish dates, and graceful degradation on a missing key or upstream failure.

The API key comes exclusively from context.secrets (the customer's stored
credential) — there is no TAVILY_API_KEY environment fallback.

Run with:
    .venv/bin/python -m unittest tests.test_web_search_tool
"""
import unittest
from unittest.mock import AsyncMock, patch

import httpx

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

    async def test_site_icons_are_requested_and_only_https_ones_kept(self):
        tool = WebSearchTool()
        data = {"results": [
            {"title": "A", "url": "https://a.example/1", "favicon": " https://a.example/favicon.ico "},
            {"title": "B", "url": "https://b.example/2", "favicon": "http://b.example/favicon.ico"},
            {"title": "C", "url": "https://c.example/3", "favicon": None},
        ]}
        search = AsyncMock(return_value=data)
        with patch.object(tool, "_search", search):
            result = await tool.run({"query": "x"}, _keyed_ctx())
        self.assertTrue(search.await_args.args[0]["include_favicon"])
        self.assertEqual([s.favicon for s in result.sources], ["https://a.example/favicon.ico", "", ""])
        self.assertEqual(result.sources[0].to_dict()["favicon"], "https://a.example/favicon.ico")
        self.assertNotIn("favicon", result.sources[1].to_dict())

    async def test_purpose_is_required_but_never_sent_to_tavily(self):
        # The model must say why it searches (the panel shows it); a call that
        # omits it anyway still runs.
        tool = WebSearchTool()
        self.assertIn("purpose", tool.parameters["required"])
        search = AsyncMock(return_value={"results": []})
        with patch.object(tool, "_search", search):
            await tool.run({"query": "x", "purpose": "Check the latest price."}, _keyed_ctx())
        self.assertNotIn("purpose", search.await_args.args[0])

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


def _tavily_replying(status: int, body):
    """Run the real _search against a stub transport, so the tool sees the
    genuine httpx.HTTPStatusError raise_for_status() raises, with Tavily's
    error body on it."""
    real_client = httpx.AsyncClient

    def reply(request):
        if isinstance(body, str):
            return httpx.Response(status, text=body)
        return httpx.Response(status, json=body)

    transport = httpx.MockTransport(reply)
    return patch("httpx.AsyncClient", lambda **kw: real_client(transport=transport, **kw))


# A query written like a task description rather than keywords: over
# Tavily's 400-character limit.
_LONG_QUERY = (
    "compare the pricing, free tiers, rate limits and enterprise features of every "
    "major hosted vector database vendor in 2026 including Pinecone Weaviate Qdrant "
    "Milvus Zilliz Chroma and pgvector based offerings, and list which of them support "
    "hybrid sparse dense search, multi tenancy, role based access control, SOC 2, HIPAA, "
    "bring your own cloud deployment and per namespace backups, with sources and dates"
)
_TOO_LONG = {"detail": {"error": "Query is too long. Max query length is 400 characters."}}


class WebSearchProviderRejectionTest(unittest.IsolatedAsyncioTestCase):
    """Tavily 400/422 mean the request itself is malformed. The model must
    learn why (so it can fix the request instead of re-sending near-copies),
    and the FAILED log must name the reason without logging the query."""

    async def test_rejection_reason_reaches_the_model(self):
        with _tavily_replying(400, _TOO_LONG):
            result = await WebSearchTool().run({"query": _LONG_QUERY}, _keyed_ctx())
        self.assertIn("Query is too long. Max query length is 400 characters.", result.content)
        self.assertIn("will fail the same way", result.content)
        self.assertNotIn("try again with a different query", result.content.lower())
        self.assertEqual(result.sources, [])

    async def test_failed_log_names_the_reason_and_shape_but_not_the_query(self):
        with _tavily_replying(400, _TOO_LONG), \
             self.assertLogs("graph_tools.tools.web_search", "ERROR") as logs:
            await WebSearchTool().run(
                {"query": _LONG_QUERY, "topic": "news", "include_domains": ["a.com", "b.com"]},
                _keyed_ctx(),
            )
        line = logs.output[0]
        self.assertIn("400 Bad Request", line)
        self.assertIn("provider says: Query is too long", line)
        self.assertIn(f"query_chars={len(_LONG_QUERY)} topic=news", line)
        self.assertIn("days=7 include_domains=2 exclude_domains=0", line)
        self.assertNotIn("vector database", line)

    async def test_validation_error_detail_is_summarised_without_inputs(self):
        body = {"detail": [{"type": "string_type", "loc": ["body", "query"],
                            "msg": "Input should be a valid string", "input": 12345}]}
        with _tavily_replying(422, body):
            result = await WebSearchTool().run({"query": "x"}, _keyed_ctx())
        self.assertIn("invalid: query: Input should be a valid string.", result.content)
        self.assertNotIn("12345", result.content)

    async def test_rejection_without_a_readable_body_names_the_status(self):
        with _tavily_replying(400, "<html>Bad Request</html>"):
            result = await WebSearchTool().run({"query": "x"}, _keyed_ctx())
        self.assertIn("rejected the request as invalid (HTTP 400).", result.content)

    async def test_server_error_stays_retryable_and_logs_the_reason(self):
        with _tavily_replying(500, {"detail": {"error": "Internal Server Error"}}), \
             self.assertLogs("graph_tools.tools.web_search", "ERROR") as logs:
            result = await WebSearchTool().run({"query": "x"}, _keyed_ctx())
        self.assertIn("Try again with a different query", result.content)
        self.assertIn("provider says: Internal Server Error", logs.output[0])

    async def test_short_query_still_succeeds_through_the_real_client(self):
        with _tavily_replying(200, _SAMPLE):
            result = await WebSearchTool().run({"query": "vector database pricing"}, _keyed_ctx())
        self.assertEqual(len(result.sources), 2)

    def test_schema_steers_the_model_to_a_short_query(self):
        description = WebSearchTool.parameters["properties"]["query"]["description"]
        self.assertIn("under 400 characters", description)


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
        self.assertEqual(spec["parameters"]["required"], ["purpose", "query"])
        # Deliberately unadvertised — models asked for the cap whenever the
        # schema offered one (run() still clamps a value passed anyway).
        self.assertNotIn("max_results", spec["parameters"]["properties"])

    async def test_counts_provider_calls_by_status(self):
        # web_search_total is the spend signal: one increment per call that
        # reached (or tried to reach) Tavily, by outcome.
        tool = WebSearchTool()
        with patch("encoding_library.observability.count") as count, \
             patch("encoding_library.observability.observe"), \
             patch("encoding_library.utils.usage_tracking.record_web_search_usage"):
            with patch.object(tool, "_search", AsyncMock(return_value=_SAMPLE)):
                await tool.run({"query": "q"}, _keyed_ctx())
            with patch.object(tool, "_search", AsyncMock(side_effect=RuntimeError("boom"))):
                await tool.run({"query": "q"}, _keyed_ctx())
            await tool.run({"query": "q"}, _ctx())
        statuses = [c.kwargs["status"] for c in count.call_args_list if c.args[0] == "web_search_total"]
        self.assertEqual(statuses, ["ok", "error", "missing_key"])


if __name__ == "__main__":
    unittest.main()
