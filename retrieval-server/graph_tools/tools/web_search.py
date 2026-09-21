"""web_search: search the web for current information.

Backend-executed tool bound to the response generator: the model decides when
to search, writes its own query, and picks the recency window — unlike a fixed
graph node that searches on every turn with a static query.

Provider: Tavily (a plain HTTPS call, independent of which LLM provider the
request resolves to). The API key is read from the TAVILY_API_KEY environment
variable — the same key the legacy WEB_SEARCH node used — so no per-request
plumbing is needed. A missing key or an upstream failure degrades to a plain
message the model can act on (it may answer from its own knowledge or retry),
never an exception that aborts the turn.

Self-contained: imports only stdlib plus httpx (imported lazily in run(), like
the other tools import their renderers), so the package stays extractable.
"""
import logging
import os

from graph_tools.base import GraphTool, ToolContext, ToolResult

logger = logging.getLogger(__name__)

_TAVILY_URL = "https://api.tavily.com/search"
_REQUEST_TIMEOUT_SECONDS = 15.0
_DEFAULT_MAX_RESULTS = 5
_MAX_RESULTS_CAP = 10
_DEFAULT_NEWS_DAYS = 7


def _format_results(query: str, topic: str, data: dict) -> str:
    """Render Tavily's payload into a compact, dated source list for the model.

    Publish dates (populated by Tavily on the "news" topic) are surfaced so the
    model can prefer the most recent sources and flag stale information."""
    results = data.get("results") or []
    if not results:
        return f"No web results found for '{query}'."

    lines = [f"Web search results for '{query}' (topic: {topic}):", ""]
    for i, r in enumerate(results, 1):
        title = (r.get("title") or "").strip()
        url = (r.get("url") or "").strip()
        published = (r.get("published_date") or "").strip()
        content = (r.get("content") or "").strip()
        header = f"[{i}] {title} ({url})"
        if published:
            header += f" — published {published}"
        lines.append(header)
        if content:
            lines.append(content)
        lines.append("")
    lines.append(
        "Base your answer on these results, preferring the most recent sources. "
        "Cite them inline with bracketed numbers, e.g. [1] or [2][3]."
    )
    return "\n".join(lines).strip()


class WebSearchTool(GraphTool):
    name = "web_search"
    description = (
        "Search the web for current, recent, or factual information. Call this "
        "whenever answering well depends on information that may have changed "
        "since your training, or that you are not certain about: news and current "
        "events, prices, schedules, releases, people's current roles, sports "
        "results, weather, or anything the user frames as 'latest', 'current', "
        "'today', or 'recent'. Prefer searching over guessing. Write a focused "
        "query, and for time-sensitive topics set topic='news'. You may call this "
        "more than once to refine or broaden a search before answering."
    )
    parameters = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": (
                    "The search query. Make it specific and keyword-focused rather "
                    "than a full sentence, e.g. 'Anthropic Claude latest model release'."
                ),
            },
            "topic": {
                "type": "string",
                "enum": ["general", "news"],
                "description": (
                    "Use 'news' for time-sensitive / current-events queries — results "
                    "are ranked by recency and carry publish dates. Use 'general' "
                    "(default) for evergreen or reference questions."
                ),
            },
            "days": {
                "type": "integer",
                "description": (
                    "For topic='news' only: how many days back to search "
                    f"(default {_DEFAULT_NEWS_DAYS}). Lower it for breaking news, "
                    "raise it for slower-moving stories."
                ),
            },
            "max_results": {
                "type": "integer",
                "description": (
                    f"How many results to return (default {_DEFAULT_MAX_RESULTS}, "
                    f"max {_MAX_RESULTS_CAP})."
                ),
            },
        },
        "required": ["query"],
    }

    async def run(self, args: dict, context: ToolContext) -> ToolResult:
        query = (args.get("query") or "").strip()
        if not query:
            return ToolResult(content="Error: query is empty — pass a search query.")

        api_key = os.getenv("TAVILY_API_KEY")
        if not api_key:
            logger.error("web_search: TAVILY_API_KEY is not set")
            return ToolResult(
                content=(
                    "Web search is unavailable right now (search is not configured). "
                    "Answer from your own knowledge if you can, and tell the user the "
                    "information may not be current."
                )
            )

        topic = args.get("topic") if args.get("topic") in ("general", "news") else "general"
        try:
            max_results = int(args.get("max_results") or _DEFAULT_MAX_RESULTS)
        except (TypeError, ValueError):
            max_results = _DEFAULT_MAX_RESULTS
        max_results = max(1, min(max_results, _MAX_RESULTS_CAP))

        payload: dict = {
            "query": query,
            "max_results": max_results,
            "search_depth": "basic",
            "topic": topic,
            "include_answer": False,
        }
        if topic == "news":
            try:
                days = int(args.get("days") or _DEFAULT_NEWS_DAYS)
            except (TypeError, ValueError):
                days = _DEFAULT_NEWS_DAYS
            payload["days"] = max(1, days)

        logger.info(
            "web_search: customer=%s topic=%s max_results=%d query='%s'",
            context.customer_id, topic, max_results, query[:100],
        )
        try:
            data = await self._search(payload, api_key)
        except Exception as e:
            logger.error("web_search: FAILED — %s", e, exc_info=True)
            return ToolResult(
                content=(
                    f"Web search failed for '{query}'. Try again with a different "
                    "query, or answer from your own knowledge and note that it may "
                    "not be current."
                )
            )

        content = _format_results(query, topic, data)
        logger.info("web_search: returned %d result(s)", len(data.get("results") or []))
        return ToolResult(content=content)

    async def _search(self, payload: dict, api_key: str) -> dict:
        """POST to Tavily with a light retry on transient network errors — the
        model can also retry by calling the tool again, so this stays minimal."""
        import httpx

        last_exc: Exception | None = None
        for attempt in range(2):
            try:
                async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT_SECONDS) as client:
                    response = await client.post(
                        _TAVILY_URL,
                        json=payload,
                        headers={"Authorization": f"Bearer {api_key}"},
                    )
                    response.raise_for_status()
                    return response.json()
            except (httpx.TransportError, httpx.TimeoutException) as e:
                last_exc = e
                logger.warning("web_search: transient error (attempt %d) — %s", attempt + 1, e)
        raise last_exc  # type: ignore[misc]
