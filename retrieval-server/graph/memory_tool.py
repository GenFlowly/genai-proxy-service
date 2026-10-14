"""search_memories: semantic search over what the system has learned about
this user.

The MEMORY node PUSHES: CORE memories every turn plus EPISODIC recall keyed on
the user's literal message. This tool lets the model PULL with its own query,
mid-reasoning ("did the user ever mention visa status?"), and reformulate
after reading results — which the feed-forward node structurally cannot do.
Same recall core as the node (graph.nodes.memory): the customer's memory
vector collections are searched and hits are joined back to DynamoDB by
memory_key, so DynamoDB stays the source of truth — a deleted memory's
leftover vector can never resurface — and results carry kind/category/updated
context instead of reading as anonymous "knowledge base" documents. All kinds
are searched (a deliberate lookup may target a CORE fact too).

Consent is layered, never left to the model:
  * BIND time — routes.retrieve._build_state drops it from builtin_tools
    unless the request carries memory_enabled (the proxy server's governance
    decision, the same gate the MEMORY node honors), so the model never even
    sees the tool without consent.
  * RUN time — the executor mirrors state's memory_enabled into
    context.runtime, and run() refuses without it. This is what keeps spawned
    subagents (whose state pins memory_enabled=False) away from memories even
    when a profile lists the tool.

EXPLICIT-ONLY (tools_runtime): a TOOL_EXECUTOR node must name it in its
config's "tools" list. Lives in graph/ rather than graph_tools/tools/ because
it reaches the server's retrieval stack through graph.nodes.memory, and
graph_tools stays extractable (stdlib + httpx only).
"""
import logging

from content_logging import redact
from encoding_library.observability import count
from graph_tools.base import GraphTool, ToolContext, ToolResult

logger = logging.getLogger(__name__)

_DEFAULT_TOP_K = 5
_TOP_K_CAP = 20
# Memories are single short sentences, so query↔memory similarity runs lower
# than query↔document chunks (knowledge tool default: 0.6). Scores are shown
# so the model judges relevance itself; the floor is just a noise gate it may
# lower for exhaustive "did they ever mention…" checks.
_DEFAULT_MIN_SCORE = 0.4


def _render_results(query: str, rows: list[tuple[dict, float]]) -> str:
    """Numbered memories with kind/category/recency and similarity — enough
    context for the model to weigh staleness instead of trusting blindly."""
    lines = [
        f"Stored memories about this user matching '{query}' "
        f"({len(rows)} match(es), highest similarity first):",
        "",
    ]
    for i, (memory, score) in enumerate(rows, 1):
        meta = [memory.get("kind") or "EPISODIC"]
        category = (memory.get("category") or "").strip()
        if category:
            meta.append(category)
        updated = str(memory.get("updatedAt") or "")[:10]
        if updated:
            meta.append(f"updated {updated}")
        lines.append(f"[{i}] {memory['text']} ({'; '.join(meta)}; similarity {score:.2f})")
    lines.append("")
    lines.append(
        "These were learned from earlier conversations and notes and may be out "
        "of date — weigh the updated dates, and never present them as something "
        "the user said just now. If these don't answer the question, search "
        "again with different keywords or a lower min_score before concluding "
        "the user never mentioned it."
    )
    return "\n".join(lines)


class SearchMemoriesTool(GraphTool):
    name = "search_memories"
    credential_ref = None
    description = (
        "Search the long-term memories you have learned about this user from "
        "past conversations and notes. Use it when the answer may depend on "
        "something the user told you before that is not in the current "
        "conversation or in your always-loaded profile of them — e.g. to check "
        "whether they ever mentioned a topic, preference, constraint, project, "
        "or past decision. Write a focused, keyword-style query; you may call "
        "it several times with different phrasings, or lower min_score, before "
        "concluding they never mentioned it."
    )
    parameters = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": (
                    "What to look for in the user's remembered facts — specific "
                    "and keyword-focused, e.g. 'visa or immigration status' "
                    "rather than a full sentence."
                ),
            },
            "top_k": {
                "type": "integer",
                "description": (
                    f"How many memories to return (default {_DEFAULT_TOP_K}, "
                    f"max {_TOP_K_CAP})."
                ),
            },
            "min_score": {
                "type": "number",
                "description": (
                    "Minimum similarity score in [0, 1] (default "
                    f"{_DEFAULT_MIN_SCORE}). Lower it (e.g. 0.3) to cast a "
                    "wider net for 'did they ever mention…' checks."
                ),
            },
        },
        "required": ["query"],
    }

    async def run(self, args: dict, context: ToolContext) -> ToolResult:
        # Run-time consent check — the bind-time gate in _build_state is the
        # primary control; this one covers subagents and any state-construction
        # path that forgets the filter. Refusal, not error: the model should
        # move on, not retry.
        if context.runtime.get("memory_enabled") is not True:
            return ToolResult(
                content=(
                    "Memory is not enabled for this request, so stored memories "
                    "cannot be searched. Answer from the conversation alone."
                )
            )

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
            "search_memories: customer=%s top_k=%d min_score=%.2f query='%s'",
            context.customer_id, top_k, min_score, redact(query, 100),
        )
        # Imported here, not at module top: the shared recall core pulls in
        # boto3/pymilvus/the embedding stack, which registry construction (and
        # the graph_tools-only unit tests) must not pay for.
        from graph.nodes.memory import (
            _RECALL_SEARCH_PARAMS,
            _embed_query,
            _get_cached_memories,
            _memory_collections,
            _milvus_client,
        )

        failure = ToolResult(
            content=(
                f"Memory search failed for '{query}'. Try again, or answer from "
                "the conversation alone and tell the user you could not check "
                "their stored memories."
            )
        )
        try:
            memories = _get_cached_memories(context.customer_id)
        except Exception as e:
            count("memory_recall_failure_total", source="tool")
            logger.error("search_memories: memory load FAILED — %s", e, exc_info=True)
            return failure
        by_key = {m["memoryId"]: m for m in memories if m.get("text") and m.get("memoryId")}
        if not by_key:
            return ToolResult(
                content=(
                    "No memories are stored for this user yet — nothing has "
                    "been learned from past conversations."
                )
            )

        try:
            client = _milvus_client(context.customer_id)
            grouped = _memory_collections(client, context.customer_id, (None, None))
            if not grouped:
                return ToolResult(
                    content=(
                        f"This user has {len(by_key)} stored memori(es), but none "
                        "are indexed for semantic search yet, so the query could "
                        "not be checked against them."
                    )
                )
            best_score: dict[str, float] = {}
            for (model_type, model_name), collection_names in grouped.items():
                vector = _embed_query(query, model_type, model_name)
                if vector is None:
                    count("embedding_failure_total", source="memory_tool", model=model_name or "")
                    logger.error(
                        "search_memories: query embedding failed for model %s/%s",
                        model_type, model_name,
                    )
                    continue
                for collection_name in collection_names:
                    search_res = client.search(
                        collection_name=collection_name,
                        data=[vector],
                        # Over-fetch: stale vectors (deleted memories) drop out
                        # in the DynamoDB join below, so the cap must survive it.
                        limit=max(top_k * 2, 8),
                        search_params=_RECALL_SEARCH_PARAMS,
                        output_fields=["memory_key"],
                    )
                    for hits in search_res:
                        for hit in hits:
                            score = hit.get("distance", 0.0)
                            if score < min_score:
                                continue
                            key = (hit.get("entity") or {}).get("memory_key")
                            if not key or key not in by_key:
                                continue
                            if score > best_score.get(key, -1.0):
                                best_score[key] = score
        except Exception as e:
            count("memory_recall_failure_total", source="tool")
            logger.error("search_memories: FAILED — %s", e, exc_info=True)
            return failure

        ranked = sorted(best_score.items(), key=lambda kv: kv[1], reverse=True)[:top_k]
        if not ranked:
            return ToolResult(
                content=(
                    f"No stored memories match '{query}' at min_score >= "
                    f"{min_score:.2f}. Try different or broader keywords, or "
                    "lower min_score (e.g. 0.3); if still nothing, the user has "
                    "not mentioned this in remembered conversations."
                )
            )
        return ToolResult(
            content=_render_results(query, [(by_key[key], score) for key, score in ranked])
        )
