"""web_search: search the web for current information.

Backend-executed tool bound to the response generator: the model decides when
to search, writes its own query, and picks the recency window — unlike a fixed
graph node that searches on every turn with a static query.

Provider: Tavily (a plain HTTPS call, independent of which LLM provider the
request resolves to). The API key is the customer's own, resolved per request
by the host and delivered through context.secrets (credential_ref
"WEB_SEARCH"); there is deliberately no platform-wide fallback key — a
customer without a stored key has no web search. A missing key or an upstream
failure degrades to a plain message the model can act on (it may answer from
its own knowledge or retry), never an exception that aborts the turn.

Self-contained: imports only stdlib plus httpx (imported lazily in run(), like
the other tools import their renderers), so the package stays extractable.
"""
import logging

from graph_tools.base import GraphTool, Source, ToolContext, ToolResult

logger = logging.getLogger(__name__)

_TAVILY_URL = "https://api.tavily.com/search"
_REQUEST_TIMEOUT_SECONDS = 15.0
_DEFAULT_MAX_RESULTS = 5
# Results beyond ~5 are rarely cited and mostly inflate the context the model
# re-reads every loop round, so the cap equals the default and max_results is
# no longer advertised in the schema (still accepted and clamped if passed).
_MAX_RESULTS_CAP = 5
_DEFAULT_NEWS_DAYS = 7
_DEFAULT_SEARCH_DEPTH = "basic"
# Tavily bills 'advanced' at 2x 'basic' — see https://docs.tavily.com pricing.
# Cost and Usage's Web Search page prices on these exact counts (see
# record_web_search_usage).
_CREDITS_PER_SEARCH_DEPTH = {"basic": 1, "advanced": 2}


def _clean_domains(value) -> list[str]:
    """Normalize a model-supplied domain list: keep non-empty strings, strip a
    stray leading scheme/'site:' the model may add. Non-lists become []."""
    if not isinstance(value, list):
        return []
    out = []
    for item in value:
        if not isinstance(item, str):
            continue
        d = item.strip().removeprefix("site:").strip()
        d = d.removeprefix("https://").removeprefix("http://").strip("/ ").strip()
        if d:
            out.append(d)
    return out


def _sources_from_data(data: dict) -> list[Source]:
    """Map Tavily's payload into structured Source objects. Publish dates
    (populated by Tavily on the "news" topic) are surfaced so the model can
    prefer the most recent sources and flag stale information. The host owns
    numbering, so nothing here carries an index."""
    return [
        Source(
            title=(r.get("title") or "").strip(),
            url=(r.get("url") or "").strip(),
            content=(r.get("content") or "").strip(),
            published_date=(r.get("published_date") or "").strip(),
        )
        for r in (data.get("results") or [])
    ]


class WebSearchTool(GraphTool):
    name = "web_search"
    # Sort key under which the proxy stores this tool's credentials in
    # CustomerToolCredentials (see the table comment in the CDK).
    credential_ref = "WEB_SEARCH"
    description = (
        "Search the web for current, recent, or factual information. Call this "
        "whenever answering well depends on information that may have changed "
        "since your training, or that you are not certain about: news and current "
        "events, prices, schedules, releases, people's current roles, sports "
        "results, weather, or anything the user frames as 'latest', 'current', "
        "'today', or 'recent'. Prefer searching over guessing. Write a focused, "
        "keyword query, and for time-sensitive topics set topic='news'. To limit "
        "the search to specific sites, pass include_domains (e.g. "
        "['docs.anthropic.com']) rather than a 'site:' operator inside the query "
        "— the query is matched as plain text, so 'site:' there does not work. "
        "One well-chosen search is usually enough. Search again only if the "
        "results come back empty or clearly off-target — and then refine the "
        "query rather than re-running variations of it. Avoid issuing several "
        "overlapping searches for the same question."
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
            "search_depth": {
                "type": "string",
                "enum": ["basic", "advanced"],
                "description": (
                    "Use 'advanced' for queries needing deeper, more thorough results — "
                    "technical research, comparisons, or anything 'basic' came back thin "
                    "or off-target for. 'advanced' costs more search credits, so reach for "
                    "it only when a query genuinely needs the extra depth. Use 'basic' "
                    "(default) for most lookups."
                ),
            },
            # max_results is deliberately NOT advertised: models asked for the
            # cap whenever offered one. run() still clamps a value a model
            # passes anyway.
            "include_domains": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Restrict results to these domains, e.g. ['docs.anthropic.com', "
                    "'github.com']. Use this instead of a 'site:' operator in the query."
                ),
            },
            "exclude_domains": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Drop results from these domains.",
            },
        },
        "required": ["query"],
    }

    async def run(self, args: dict, context: ToolContext) -> ToolResult:
        query = (args.get("query") or "").strip()
        if not query:
            return ToolResult(content="Error: query is empty — pass a search query.")

        credentials = context.secrets(self.credential_ref) or {}
        api_key = credentials.get("api_key")
        if not api_key:
            logger.warning(
                "web_search: customer=%s has no stored Tavily key", context.customer_id
            )
            return ToolResult(
                content=(
                    "Web search is unavailable right now (search is not configured). "
                    "Answer from your own knowledge if you can, and tell the user the "
                    "information may not be current."
                )
            )

        topic = args.get("topic") if args.get("topic") in ("general", "news") else "general"
        search_depth = args.get("search_depth") if args.get("search_depth") in _CREDITS_PER_SEARCH_DEPTH \
            else _DEFAULT_SEARCH_DEPTH
        try:
            max_results = int(args.get("max_results") or _DEFAULT_MAX_RESULTS)
        except (TypeError, ValueError):
            max_results = _DEFAULT_MAX_RESULTS
        max_results = max(1, min(max_results, _MAX_RESULTS_CAP))

        payload: dict = {
            "query": query,
            "max_results": max_results,
            "search_depth": search_depth,
            "topic": topic,
            "include_answer": False,
        }
        if topic == "news":
            try:
                days = int(args.get("days") or _DEFAULT_NEWS_DAYS)
            except (TypeError, ValueError):
                days = _DEFAULT_NEWS_DAYS
            payload["days"] = max(1, days)
        # Domain scoping is a first-class Tavily param; the model should reach
        # for these rather than a 'site:' operator, which Tavily matches as
        # literal query text and returns junk for.
        include_domains = _clean_domains(args.get("include_domains"))
        exclude_domains = _clean_domains(args.get("exclude_domains"))
        if include_domains:
            payload["include_domains"] = include_domains
        if exclude_domains:
            payload["exclude_domains"] = exclude_domains

        logger.info(
            "web_search: customer=%s topic=%s search_depth=%s max_results=%d query='%s'",
            context.customer_id, topic, search_depth, max_results, query[:100],
        )
        try:
            data = await self._search(payload, api_key)
            # Tavily bills the call itself, not the result count — record usage
            # as soon as the request succeeds, even if 0 results come back.
            self._record_usage(context.customer_id, search_depth)
        except Exception as e:
            logger.error("web_search: FAILED — %s", e, exc_info=True)
            # Tavily's auth/quota statuses are terminal for the whole turn —
            # retrying with a new query cannot succeed, so say that outright
            # instead of inviting the retry loop the generic message allows.
            # 432 = key/plan limit exceeded, 433 = pay-as-you-go cap, per
            # https://docs.tavily.com (401 = invalid key).
            status = getattr(getattr(e, "response", None), "status_code", None)
            if status in (432, 433):
                return ToolResult(
                    content=(
                        "Web search is unavailable: the search provider account for "
                        "the connected API key is out of credits or "
                        "over its plan limit. Retrying will not help. Answer from "
                        "your own knowledge, note it may not be current, and tell "
                        "the user their web-search credits are exhausted."
                    )
                )
            if status == 401:
                return ToolResult(
                    content=(
                        "Web search is unavailable: the connected "
                        "search API key was rejected as invalid. "
                        "Retrying will not help. Answer from your own knowledge, "
                        "note it may not be current, and tell the user their "
                        "web-search API key needs to be corrected in settings."
                    )
                )
            return ToolResult(
                content=(
                    f"Web search failed for '{query}'. Try again with a different "
                    "query, or answer from your own knowledge and note that it may "
                    "not be current."
                )
            )

        sources = _sources_from_data(data)
        logger.info("web_search: returned %d result(s)", len(sources))
        if not sources:
            return ToolResult(content=f"No web results found for '{query}'.")
        # A short preamble only — the host appends the numbered source list and
        # the citation instruction, so numbering stays consistent across calls.
        preamble = (
            f"Web search results for '{query}' (topic: {topic}). Base your answer "
            "on the sources below, preferring the most recent, and note when "
            "information may be outdated."
        )
        return ToolResult(content=preamble, sources=sources)

    @staticmethod
    def _record_usage(customer_id: str, search_depth: str) -> None:
        """Best-effort: never let a usage-recording failure affect a
        successful search. See encoding_library.utils.usage_tracking —
        record_web_search_usage writes raw credit counts only (no pricing
        here); genai-proxy-server's UsageSummaryService prices them at read
        time against the admin rate card, same as Vector DB."""
        try:
            from encoding_library.utils.usage_tracking import record_web_search_usage
            credits = _CREDITS_PER_SEARCH_DEPTH[search_depth]
            record_web_search_usage(customer_id, search_depth, credits)
        except Exception:
            logger.warning(
                "web_search: failed to record usage for customer=%s", customer_id, exc_info=True
            )

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
