"""search_knowledge_base: semantic search over the customer's knowledge base.

Backend-executed tool bound to the response generator: the model decides
WHETHER to search (it skips chitchat turns a pipeline would retrieve for),
writes its own query, and iterates — it can refine the query after reading the
first results, which a feed-forward RETRIEVAL node structurally cannot do.
Same retriever core as the RETRIEVAL node (graph.nodes.retrieval
.search_knowledge), so relevance improvements land on both paths.

Lives in graph/ rather than graph_tools/tools/ deliberately: it reaches into
the server's retrieval stack (pymilvus, encoding_library), and graph_tools is
kept extractable (stdlib + httpx only). It is registered as a built-in by
graph.tools_runtime, but EXPLICIT-ONLY: a TOOL_EXECUTOR node must name it in
its config's "tools" list — the all-built-ins enablement default excludes it,
so adding this tool can never make an existing pipeline graph retrieve twice.

No credential_ref: the vector store is reached by customer_id through the same
server-held connection the RETRIEVAL node uses, not a caller credential.
"""
import logging

from content_logging import redact
from graph_tools.base import GraphTool, ToolContext, ToolResult

logger = logging.getLogger(__name__)

_DEFAULT_TOP_K = 5
_TOP_K_CAP = 20
# Matches the request-schema default the RETRIEVAL node runs with, so the tool
# is no noisier than the pipeline unless the model explicitly loosens it.
_DEFAULT_MIN_SCORE = 0.6
# Same Milvus search params the request schema defaults to (models.py).
_DEFAULT_SEARCH_PARAMS = {"metric_type": "COSINE", "params": {"nprobe": 10}}


def _render_results(query: str, results: list[dict]) -> str:
    """Numbered chunks with titles and similarity scores. Scores are shown so
    the model can judge relevance itself instead of trusting a cutoff."""
    lines = [
        f"Knowledge base results for '{query}' ({len(results)} match(es), "
        "highest similarity first):",
        "",
    ]
    for i, r in enumerate(results, 1):
        entity = r.get("entity", {}) or {}
        # Conversation chunks carry no title; name the source so the model can
        # attribute ("in an earlier conversation you said...") instead of
        # citing an "(untitled)" document.
        is_conversation = str(r.get("source_collection", "")).split("_", 1)[0] == "conversation"
        fallback = "(past conversation)" if is_conversation else "(untitled)"
        title = entity.get("title") or entity.get("subject") or fallback
        body = (entity.get("note_value") or "").strip()
        lines.append(f"[{i}] {title} (similarity {r.get('distance', 0.0):.2f})")
        if body:
            lines.append(body)
        lines.append("")
    lines.append(
        "Answer using these results where they are relevant. If they do not "
        "cover the question, you may search again with different keywords."
    )
    return "\n".join(lines).strip()


class SearchKnowledgeBaseTool(GraphTool):
    name = "search_knowledge_base"
    credential_ref = None
    description = (
        "Search this customer's private knowledge base (their stored notes, "
        "documents, records, and past conversation history) for information "
        "relevant to the user's question. Call this whenever the answer may "
        "depend on the customer's own data rather than general knowledge, "
        "including things they told you in earlier conversations. Write a focused, "
        "keyword-style query. You may call it several times with different "
        "queries to cover multi-part questions, or refine the query after "
        "reading the first results. If nothing comes back, retry once with "
        "broader phrasing or a lower min_score before concluding the "
        "knowledge base does not cover the topic."
    )
    parameters = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": (
                    "The search query — specific and keyword-focused, e.g. "
                    "'refund policy digital purchases' rather than a full sentence."
                ),
            },
            "top_k": {
                "type": "integer",
                "description": (
                    f"How many results to return (default {_DEFAULT_TOP_K}, "
                    f"max {_TOP_K_CAP}). Raise it for broad or multi-part questions."
                ),
            },
            "min_score": {
                "type": "number",
                "description": (
                    "Minimum similarity score in [0, 1] (default "
                    f"{_DEFAULT_MIN_SCORE}). Lower it (e.g. 0.4) to cast a wider "
                    "net when a first search returns nothing."
                ),
            },
        },
        "required": ["query"],
    }

    async def run(self, args: dict, context: ToolContext) -> ToolResult:
        query = (args.get("query") or "").strip()
        if not query:
            return ToolResult(content="Error: query is empty — pass a search query.")

        try:
            top_k = int(args.get("top_k") or _DEFAULT_TOP_K)
        except (TypeError, ValueError):
            top_k = _DEFAULT_TOP_K
        top_k = max(1, min(top_k, _TOP_K_CAP))
        try:
            min_score = float(args.get("min_score"))
        except (TypeError, ValueError):
            min_score = _DEFAULT_MIN_SCORE
        min_score = max(0.0, min(min_score, 1.0))

        logger.info(
            "search_knowledge_base: customer=%s top_k=%d min_score=%.2f query='%s'",
            context.customer_id, top_k, min_score, redact(query, 100),
        )
        # Imported here, not at module top: pulls in pymilvus + the embedding
        # stack, which registry construction (and the graph_tools-only unit
        # tests) must not pay for.
        from graph.nodes.retrieval import search_knowledge

        try:
            results = await search_knowledge(
                customer_id=context.customer_id,
                query=query,
                top_n=top_k,
                similarity_threshold=min_score,
                search_params=_DEFAULT_SEARCH_PARAMS,
            )
        except Exception as e:
            # Degrade to a message the model can act on — an exception here
            # would become "Error executing ..." anyway, but this phrasing
            # tells the model what to do next.
            logger.error("search_knowledge_base: FAILED — %s", e, exc_info=True)
            return ToolResult(
                content=(
                    f"Knowledge base search failed for '{query}'. Try again, or "
                    "answer from the conversation alone and tell the user you "
                    "could not check their knowledge base."
                )
            )

        if not results:
            return ToolResult(
                content=(
                    f"No knowledge base results for '{query}' at min_score "
                    f">= {min_score:.2f}. Try different or broader keywords, or "
                    "lower min_score; if nothing turns up, the knowledge base "
                    "likely does not cover this topic."
                )
            )
        return ToolResult(content=_render_results(query, results))
