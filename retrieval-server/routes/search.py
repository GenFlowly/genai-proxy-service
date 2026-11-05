import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from content_logging import redact
from encoding_library.observability import count, track
from encoding_library.utils.embedding_utils import EmbeddingKeyMissing, create_embeddings
from encoding_library.utils.model_registry import parse_collection_description, resolve_model
from encoding_library.utils.vector_db import (
    VectorDBNotConfigured,
    collection_data_type,
    customer_filter,
    escape_filter_value,
    get_milvus_client,
)
from graph.nodes.retrieval import customer_embedding_model

logger = logging.getLogger(__name__)

router = APIRouter()

# Chunk-level fan-out per collection; several chunks usually collapse into one
# source item, so this is deliberately larger than the result limit.
_CHUNK_SEARCH_LIMIT = 50

# Collections are shared across tenants, named '{type}_{model_name}' with a
# customer_id partition key (encoding_library.utils.vector_db); the first
# name segment is the data type. Per-type grouping key: chunk hits sharing
# this entity field collapse into one result. Types absent from this map
# (including future ones) group by the row id — one result per vector —
# which is always safe; add an entry here when a new chunked type ships.
_GROUP_FIELD_BY_TYPE = {
    "conversation": "conversation_key",
    "notes": "note_key",
    "memory": "memory_key",
    "instructions": "instruction_key",
    # "email": rows are one-per-email already (id = message_id)
}

# Requested across all collections; schemas have enable_dynamic_field=True so
# fields a given schema lacks are tolerated (same convention as the RAG
# retrieval node's fixed output_fields list).
_OUTPUT_FIELDS = [
    "note_value", "title", "subject", "client", "created_at", "date",
    "conversation_key", "message_key", "note_key", "memory_key",
    "instruction_key", "version", "category",
    "from_email", "folder",
]


class SearchRequest(BaseModel):
    customer_id: str
    query: str
    top_n: int = 10
    # Data types to search (e.g. ["conversation", "notes"]); None = everything
    types: list[str] | None = None
    similarity_threshold: float = 0.0
    # Per-type allow-list of group-key values, e.g.
    # {"instructions": ["INS-1", "INS-2"]}. A listed type is matched by group
    # key INSTEAD of by the caller's customer_id — the caller owns access
    # control there, and the rows may live under other customers' partitions
    # (shared items are indexed once, under their creator). An empty list means
    # the caller can access nothing of that type. Unlisted types keep the
    # customer_id scope.
    allowed_keys: dict[str, list[str]] | None = None


def _row_filter(req: SearchRequest, data_type: str) -> str | None:
    """
    Milvus row filter for one collection: the caller's own partition by
    default; types listed in allowed_keys are matched by group key instead
    (losing partition pruning — the allow-list IS the access control).
    None means nothing can match — skip the collection. Types without a
    group field can't be key-filtered, so an allow-list on them skips too
    rather than silently widening to customer scope.
    """
    allowed = (req.allowed_keys or {}).get(data_type)
    if allowed is None:
        return customer_filter(req.customer_id)
    group_field = _GROUP_FIELD_BY_TYPE.get(data_type)
    if not group_field or not allowed:
        return None
    quoted = ", ".join(f'"{escape_filter_value(key)}"' for key in allowed)
    return f"{group_field} in [{quoted}]"


def _snippet(entity: dict) -> str:
    return entity.get("note_value") or entity.get("subject") or ""


def _title(entity: dict) -> str:
    return entity.get("title") or entity.get("subject") or ""


def _not_configured_detail(e: Exception) -> dict:
    # error_type tells the caller which setting is missing, so the app can
    # point the user at it.
    error_type = (
        "embedding_key_missing" if isinstance(e, EmbeddingKeyMissing) else "vector_db_not_configured"
    )
    return {"error_type": error_type, "message": str(e)}


@router.post("/search")
@track("vector_retrieval", source="search")
async def search(req: SearchRequest):
    """
    Unified semantic search over all of a customer's vector collections —
    conversations, notes, memories, emails and any future data type. Chunk
    hits are grouped per source item (conversation, note, ...); each item
    returns once with its best-matching snippet and score. Callers own
    enrichment and visibility filtering (archived conversations, soft-deleted
    notes) — the index knows only chunk text and keys.
    """
    if not req.customer_id or not req.query.strip():
        raise HTTPException(status_code=400, detail="customer_id and query are required")

    wanted_types = {t.strip().lower() for t in req.types} if req.types else None
    logger.info(
        "Unified search — customer=%s types=%s allowed_keys=%s query='%s'",
        req.customer_id,
        sorted(wanted_types) if wanted_types else "all",
        {t: len(keys) for t, keys in req.allowed_keys.items()} if req.allowed_keys else None,
        redact(req.query, 100),
    )

    try:
        client = get_milvus_client(req.customer_id)

        # Group the shared collections by embedding model (from the
        # collection-description metadata) so the query is embedded once per
        # distinct model — same convention as the RAG retrieval node.
        grouped: dict[tuple[str, str], list[tuple[str, str, str]]] = {}
        for name in client.list_collections():
            data_type = collection_data_type(name)
            if data_type is None:
                continue
            if wanted_types is not None and data_type not in wanted_types:
                continue
            row_filter = _row_filter(req, data_type)
            if row_filter is None:
                continue
            model = resolve_model(None, None)
            try:
                meta = parse_collection_description(client.describe_collection(name).get("description"))
                if meta:
                    model = resolve_model(meta.get("model_type"), meta.get("model_name"))
            except Exception as e:
                logger.warning("Could not read metadata for collection '%s': %s", name, e)
            grouped.setdefault(model, []).append((name, data_type, row_filter))

        if not grouped:
            logger.info("No matching collections for customer %s", req.customer_id)
            return {"results": []}

        # Best chunk hit per (type, group key) across all collections
        by_item: dict[tuple[str, str], dict] = {}
        for (model_type, model_name), collections in grouped.items():
            encoder = customer_embedding_model(req.customer_id, model_type, model_name)
            query_embeddings = create_embeddings([req.query], encoder, customer_id=req.customer_id)
            if not query_embeddings:
                count("embedding_failure_total", source="search", model=model_name)
                logger.error("Query embedding failed for model %s/%s", model_type, model_name)
                continue
            query_vector = query_embeddings[0].get("vector")

            for collection_name, data_type, row_filter in collections:
                search_res = client.search(
                    collection_name=collection_name,
                    data=[query_vector],
                    # Customer partition by default; allow-listed types match
                    # by group key across partitions (see _row_filter).
                    filter=row_filter,
                    limit=_CHUNK_SEARCH_LIMIT,
                    output_fields=_OUTPUT_FIELDS,
                )
                group_field = _GROUP_FIELD_BY_TYPE.get(data_type)
                for hits in search_res:
                    for hit in hits:
                        distance = hit.get("distance", 0.0)
                        if distance < req.similarity_threshold:
                            continue
                        entity = hit.get("entity", {})
                        group_value = (entity.get(group_field) if group_field else None) or hit.get("id")
                        if not group_value:
                            continue
                        item_key = (data_type, str(group_value))
                        existing = by_item.get(item_key)
                        if existing is None:
                            by_item[item_key] = {
                                "type": data_type,
                                "key": str(group_value),
                                "score": distance,
                                "snippet": _snippet(entity),
                                "title": _title(entity),
                                "created_at": entity.get("created_at") or entity.get("date") or "",
                                "client": entity.get("client", ""),
                                "matched_chunks": 1,
                                "source_collection": collection_name,
                            }
                        else:
                            existing["matched_chunks"] += 1
                            if distance > existing["score"]:
                                existing.update(
                                    score=distance,
                                    snippet=_snippet(entity),
                                    title=_title(entity),
                                    created_at=entity.get("created_at") or entity.get("date") or "",
                                )

        results = sorted(by_item.values(), key=lambda r: r["score"], reverse=True)[:req.top_n]
        logger.info(
            "Unified search — %d grouped item(s), returning %d",
            len(by_item), len(results),
        )
        return {"results": results}
    except (EmbeddingKeyMissing, VectorDBNotConfigured) as e:
        # Customer state, not an infrastructure failure: no stored key for the
        # embedding provider, or no vector DB configured. 409 so the caller
        # can tell the user why instead of showing mysteriously empty results.
        logger.warning("Unified search unavailable for customer=%s: %s", req.customer_id, e)
        raise HTTPException(status_code=409, detail=_not_configured_detail(e))
    except Exception as e:
        logger.error("Unified search failed for customer=%s: %s", req.customer_id, e, exc_info=True)
        raise HTTPException(status_code=500, detail="Search failed")
