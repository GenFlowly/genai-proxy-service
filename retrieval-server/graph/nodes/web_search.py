import asyncio
import logging
import os

import httpx

from content_logging import redact
from encoding_library.observability import count, track
from encoding_library.utils.retry import is_transient_http_error, retry
from graph.state import RetrievalState
from graph.tool_credentials import resolve_tool_credentials
from graph_tools.tools.web_search import WebSearchTool

logger = logging.getLogger(__name__)

_TAVILY_URL = "https://api.tavily.com/search"
_DEFAULT_MAX_RESULTS = 5
_REQUEST_TIMEOUT_SECONDS = 15.0

# The credential the Settings page stores for the web_search TOOL. The node
# honors the same row, so a customer's connected Tavily key applies no matter
# whether their graph searches through this fixed node or the model-called tool.
_CREDENTIAL_REF = WebSearchTool.credential_ref


def web_search(node_id: str | None = None):
    """Factory: web-search node reading its own (nodeId-keyed) config, with a
    nodeType-keyed fallback for statically-built graphs."""
    async def node(state: RetrievalState) -> dict:
        return await _web_search(state, node_id)

    node.__name__ = "web_search"
    return node


async def _web_search(state: RetrievalState, node_id: str | None) -> dict:
    """
    Search the web for the current query and write results into state.

    Provider-agnostic by design: a plain HTTP call to Tavily, independent of
    which LLM provider the request resolves to. A failed search degrades to an
    empty result list (the graph can still answer from retrieval context) —
    only a missing API key is surfaced as a state error, since that is a
    configuration bug rather than a transient upstream failure.

    The API key is resolved per request: the customer's stored WEB_SEARCH
    credential (saved from the Settings page, same row the web_search tool
    reads) wins, then the node config's api_key, then the platform-wide
    TAVILY_API_KEY env var.

    Config (node_configs["WEB_SEARCH"], all optional except the API key):
      api_key          (str)  — Tavily key; used only when the customer has not
                         connected their own, before the TAVILY_API_KEY env var
      query_key        (str)  — state/scratch field holding a focused search
                         query (e.g. written by an upstream analyzer node);
                         falls back to rewritten_query/original_query when
                         unset or empty
      max_results      (int)  — results to request (default 5)
      search_depth     (str)  — "basic" (default) | "advanced" (costs more credits)
      topic            (str)  — "general" (default) | "news" | "finance"
      include_answer   (bool) — ask Tavily for a synthesized answer string
      include_domains  (list) — restrict search to these domains
      exclude_domains  (list) — drop these domains from results
      citation_instruction (str) — appended to {web_context} so the generator
                         cites sources as [n]; defaults to a built-in sentence
                         (see llm_node._DEFAULT_CITATION_INSTRUCTION), "" disables

    Writes:
      web_search_results — [{title, url, content, score}, ...]
      web_search_answer  — Tavily's synthesized answer ("" unless include_answer)
    """
    configs = state.get("node_configs", {})
    config = (configs.get(node_id) if node_id else None) or configs.get("WEB_SEARCH", {})

    query_key = config.get("query_key")
    focused_query = None
    if query_key:
        focused_query = (state.get("scratch") or {}).get(query_key) or state.get(query_key)
    query = focused_query or state.get("rewritten_query") or state["original_query"]

    customer_id = state["customer_id"]
    logger.info(
        "Node web_search: START — customer=%s focused=%s query='%s'",
        customer_id, bool(focused_query), redact(query, 100),
    )

    api_key, key_source = await _resolve_api_key(customer_id, config)
    if not api_key:
        count("web_search_total", status="missing_key")
        logger.error(
            "Node web_search: customer=%s has no stored WEB_SEARCH credential, no "
            "node-config api_key, and TAVILY_API_KEY is not set", customer_id,
        )
        return {"web_search_results": [], "web_search_answer": "", "error": "Web search is not configured (missing API key)"}
    logger.info("Node web_search: using %s Tavily key", key_source)

    payload: dict = {
        "query": query,
        "max_results": int(config.get("max_results") or _DEFAULT_MAX_RESULTS),
        "search_depth": config.get("search_depth", "basic"),
        "topic": config.get("topic", "general"),
        "include_answer": bool(config.get("include_answer", False)),
    }
    if config.get("include_domains"):
        payload["include_domains"] = config["include_domains"]
    if config.get("exclude_domains"):
        payload["exclude_domains"] = config["exclude_domains"]

    # A failed search degrades to empty results, so the metric lives on the
    # raising inner call — without it, "Tavily is down" and "no results" are
    # indistinguishable to alarms.
    try:
        data = await _tavily_search(payload, api_key)
    except Exception as e:
        logger.error("Node web_search: FAILED — %s", e, exc_info=True)
        return {"web_search_results": [], "web_search_answer": ""}

    results = [
        {
            "title": r.get("title", ""),
            "url": r.get("url", ""),
            "content": r.get("content", ""),
            "score": r.get("score", 0.0),
        }
        for r in data.get("results", [])
    ]
    logger.info("Node web_search: END — %d result(s) returned", len(results))
    return {"web_search_results": results, "web_search_answer": data.get("answer") or ""}


async def _resolve_api_key(customer_id: str, config: dict) -> tuple[str | None, str]:
    """The Tavily key for this run and where it came from ("customer" |
    "node_config" | "platform" | "none").

    The customer's stored WEB_SEARCH credential wins — connecting a key in the
    Settings page must take effect without a graph edit — then the node
    config's api_key, then the platform env var. The lookup is DynamoDB + KMS
    through blocking boto3, so it runs off the event loop; a lookup FAILURE
    (not a miss) degrades to the fallbacks rather than aborting the turn, the
    same posture as tool_executor.
    """
    stored = None
    try:
        resolved = await asyncio.to_thread(
            resolve_tool_credentials, customer_id, [_CREDENTIAL_REF]
        )
        stored = (resolved.get(_CREDENTIAL_REF) or {}).get("api_key")
    except Exception as e:
        logger.error(
            "Node web_search: could not resolve stored credentials for customer=%s "
            "— falling back to node config / platform key (%s)",
            customer_id, e, exc_info=True,
        )
    if stored:
        return stored, "customer"
    if config.get("api_key"):
        return config["api_key"], "node_config"
    env_key = os.getenv("TAVILY_API_KEY")
    if env_key:
        return env_key, "platform"
    return None, "none"


@track("web_search")
@retry("tavily", retry_if=is_transient_http_error)
async def _tavily_search(payload: dict, api_key: str) -> dict:
    async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT_SECONDS) as client:
        response = await client.post(
            _TAVILY_URL,
            json=payload,
            headers={"Authorization": f"Bearer {api_key}"},
        )
        response.raise_for_status()
        return response.json()
