import logging
import os

import httpx

from graph.state import RetrievalState

logger = logging.getLogger(__name__)

_TAVILY_URL = "https://api.tavily.com/search"
_DEFAULT_MAX_RESULTS = 5
_REQUEST_TIMEOUT_SECONDS = 15.0


async def web_search(state: RetrievalState) -> dict:
    """
    Search the web for the current query and write results into state.

    Provider-agnostic by design: a plain HTTP call to Tavily, independent of
    which LLM provider the request resolves to. A failed search degrades to an
    empty result list (the graph can still answer from retrieval context) —
    only a missing API key is surfaced as a state error, since that is a
    configuration bug rather than a transient upstream failure.

    Config (node_configs["WEB_SEARCH"], all optional except the API key):
      api_key          (str)  — Tavily key; falls back to TAVILY_API_KEY env var
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
    query = state.get("rewritten_query") or state["original_query"]
    customer_id = state["customer_id"]
    logger.info("Node web_search: START — customer=%s query='%s'", customer_id, query[:100])

    config = state.get("node_configs", {}).get("WEB_SEARCH", {})
    api_key = config.get("api_key") or os.getenv("TAVILY_API_KEY")
    if not api_key:
        logger.error("Node web_search: no API key in node config or TAVILY_API_KEY env")
        return {"web_search_results": [], "web_search_answer": "", "error": "Web search is not configured (missing API key)"}

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

    try:
        async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.post(
                _TAVILY_URL,
                json=payload,
                headers={"Authorization": f"Bearer {api_key}"},
            )
            response.raise_for_status()
            data = response.json()

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

    except Exception as e:
        logger.error("Node web_search: FAILED — %s", e, exc_info=True)
        return {"web_search_results": [], "web_search_answer": ""}
