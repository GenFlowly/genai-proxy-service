import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from encoding_library.utils.embedding_utils import create_embeddings
from encoding_library.utils.model_registry import parse_collection_description, resolve_model
from encoding_library.utils.vector_db import get_milvus_client
from graph.nodes.retrieval import _get_cached_embedding_model

logger = logging.getLogger(__name__)

router = APIRouter()

# Chunk-level fan-out per collection; several chunks usually collapse into one
# conversation, so this is deliberately larger than the conversation limit.
_CHUNK_SEARCH_LIMIT = 50


class SearchConversationsRequest(BaseModel):
    customer_id: str
    query: str
    top_n: int = 10
    similarity_threshold: float = 0.0


@router.post("/search-conversations")
async def search_conversations(req: SearchConversationsRequest):
    """
    Semantic search over the customer's conversation collections
    ('{customer_id}_conversation_{model_name}'). Chunk hits are grouped by
    conversation_key; each conversation returns once with its best-matching
    snippet and score. The caller owns enrichment (titles) and visibility
    filtering (archived conversations) — the index knows only chunk text.
    """
    if not req.customer_id or not req.query.strip():
        raise HTTPException(status_code=400, detail="customer_id and query are required")

    logger.info("Searching conversations — customer=%s query='%s'", req.customer_id, req.query[:100])

    try:
        client = get_milvus_client(req.customer_id)
        conversation_prefix = f"{req.customer_id}_conversation"

        # Group this customer's conversation collections by embedding model
        # (from the collection-description metadata) so the query is embedded
        # once per distinct model — same convention as the RAG retrieval node.
        grouped: dict[tuple[str, str], list[str]] = {}
        for name in client.list_collections():
            if not name.startswith(conversation_prefix):
                continue
            model = resolve_model(None, None)
            try:
                meta = parse_collection_description(client.describe_collection(name).get("description"))
                if meta:
                    model = resolve_model(meta.get("model_type"), meta.get("model_name"))
            except Exception as e:
                logger.warning("Could not read metadata for collection '%s': %s", name, e)
            grouped.setdefault(model, []).append(name)

        if not grouped:
            logger.info("No conversation collections found for customer %s", req.customer_id)
            return {"conversations": []}

        # Best chunk hit per conversation across all collections
        by_conversation: dict[str, dict] = {}
        for (model_type, model_name), collection_names in grouped.items():
            encoder = _get_cached_embedding_model(model_type, model_name)
            query_embeddings = create_embeddings([req.query], encoder)
            if not query_embeddings:
                logger.error("Query embedding failed for model %s/%s", model_type, model_name)
                continue
            query_vector = query_embeddings[0].get("vector")

            for collection_name in collection_names:
                search_res = client.search(
                    collection_name=collection_name,
                    data=[query_vector],
                    limit=_CHUNK_SEARCH_LIMIT,
                    output_fields=["note_value", "title", "conversation_key", "message_key", "created_at", "client"],
                )
                for hits in search_res:
                    for hit in hits:
                        distance = hit.get("distance", 0.0)
                        if distance < req.similarity_threshold:
                            continue
                        entity = hit.get("entity", {})
                        conversation_key = entity.get("conversation_key")
                        if not conversation_key:
                            continue
                        existing = by_conversation.get(conversation_key)
                        if existing is None:
                            by_conversation[conversation_key] = {
                                "conversation_key": conversation_key,
                                "score": distance,
                                "snippet": entity.get("note_value", ""),
                                "message_key": entity.get("message_key", ""),
                                "created_at": entity.get("created_at", ""),
                                "client": entity.get("client", ""),
                                "matched_chunks": 1,
                            }
                        else:
                            existing["matched_chunks"] += 1
                            if distance > existing["score"]:
                                existing.update(
                                    score=distance,
                                    snippet=entity.get("note_value", ""),
                                    message_key=entity.get("message_key", ""),
                                    created_at=entity.get("created_at", ""),
                                )

        conversations = sorted(by_conversation.values(), key=lambda c: c["score"], reverse=True)[:req.top_n]
        logger.info(
            "Conversation search — %d chunk-grouped conversation(s), returning %d",
            len(by_conversation), len(conversations),
        )
        return {"conversations": conversations}
    except Exception as e:
        logger.error("Conversation search failed for customer=%s: %s", req.customer_id, e, exc_info=True)
        raise HTTPException(status_code=500, detail="Conversation search failed")
