import logging
from typing import Any

from pymilvus import MilvusClient

from encoding_library.observability import count, track
from encoding_library.utils.embedding_utils import create_embeddings, get_embedding_model
from encoding_library.utils.model_registry import parse_collection_description, resolve_model
from encoding_library.utils.vector_db import get_milvus_client
from graph.state import RetrievalState

logger = logging.getLogger(__name__)

_embedding_model_cache: dict[tuple[str, str], Any] = {}


def _get_cached_embedding_model(model_type: str | None, model_name: str | None) -> Any:
    key = resolve_model(model_type, model_name)
    if key not in _embedding_model_cache:
        logger.info("Loading embedding model type=%s name=%s (first time)", key[0], key[1])
        _embedding_model_cache[key] = get_embedding_model(model_type, model_name)
    return _embedding_model_cache[key]


def _discover_collections(
    client: MilvusClient, customer_id: str, fallback_model: tuple[str | None, str | None]
) -> dict[tuple[str, str], list[str]]:
    """
    Find this customer's collections and group them by embedding model.

    The model is read from the collection-description metadata written at
    creation time (model_registry.build_collection_description). Legacy
    collections without metadata fall back to the request-supplied model
    (or the platform default).
    """
    grouped: dict[tuple[str, str], list[str]] = {}
    for name in client.list_collections():
        if name != customer_id and not name.startswith(f"{customer_id}_"):
            continue
        # Conversation collections back the explicit conversation-search
        # feature (/search-conversations) only — surfacing past chats in
        # generation context would need its own product decision.
        if name.startswith(f"{customer_id}_conversation"):
            continue
        # Instruction collections back semantic instruction search only —
        # instruction (persona) text is not knowledge and must not be
        # injected into generation context.
        if name.startswith(f"{customer_id}_instructions"):
            continue
        model = resolve_model(*fallback_model)
        try:
            meta = parse_collection_description(client.describe_collection(name).get("description"))
            if meta:
                model = resolve_model(meta.get("model_type"), meta.get("model_name"))
        except Exception as e:
            logger.warning("Could not read metadata for collection '%s': %s", name, e)
        grouped.setdefault(model, []).append(name)
    return grouped


def retrieval(node_id: str | None = None):
    """Factory: retrieval node reading its own (nodeId-keyed) config, with a
    nodeType-keyed fallback for statically-built graphs."""
    async def node(state: RetrievalState) -> dict:
        return await _retrieval(state, node_id)

    node.__name__ = "retrieval"
    return node


async def _retrieval(state: RetrievalState, node_id: str | None) -> dict:
    # The graph degrades gracefully (empty results + error in state), so the
    # metric lives on the raising inner function — a swallowed failure here
    # would otherwise be invisible to alarms.
    try:
        return await _retrieval_impl(state, node_id)
    except Exception as e:
        logger.error("Node retrieval: FAILED — %s", e, exc_info=True)
        return {"retrieval_results": [], "error": str(e)}


async def _retrieval_impl(state: RetrievalState, node_id: str | None) -> dict:
    query = state.get("rewritten_query") or state["original_query"]
    customer_id = state["customer_id"]
    logger.info("Node retrieval: START — customer=%s query='%s'", customer_id, query[:100])

    configs = state.get("node_configs", {})
    config = (configs.get(node_id) if node_id else None) or configs.get("RETRIEVAL", {})
    top_n = config.get("top_n") or state["top_n"]
    similarity_threshold = config.get("similarity_threshold") or state["similarity_threshold"]
    search_params = config.get("search_params") or state["search_params"]

    results = await search_knowledge(
        customer_id=customer_id,
        query=query,
        top_n=top_n,
        similarity_threshold=similarity_threshold,
        search_params=search_params,
        model_type=state.get("model_type"),
        model_name=state.get("model_name"),
    )
    return {"retrieval_results": results}


@track("vector_retrieval", source="retrieve")
async def search_knowledge(
    customer_id: str,
    query: str,
    top_n: int,
    similarity_threshold: float,
    search_params: dict,
    model_type: str | None = None,
    model_name: str | None = None,
) -> list[dict]:
    """Semantic search over a customer's knowledge collections.

    The shared core behind the RETRIEVAL node and the search_knowledge_base
    built-in tool (graph.knowledge_tool) — one implementation so relevance
    changes land on both the pipeline and the agent path. Returns the result
    dicts the pipeline has always produced ({id, distance, entity,
    source_collection}), sorted by score, at most top_n. Raises on
    infrastructure failure; callers own their degradation story.
    """
    logger.info("Node retrieval: connecting to Zilliz for customer=%s", customer_id)
    # get_milvus_client returns a retry-wrapped client (backoff on every call)
    client = get_milvus_client(customer_id)
    logger.info("Node retrieval: connected to Zilliz")

    grouped = _discover_collections(client, customer_id, (model_type, model_name))
    if not grouped:
        logger.warning("Node retrieval: no collections found for customer=%s", customer_id)
        return []

    all_results = []

    # Embed the query once per distinct model, then search that model's collections.
    # Distances from different models are merged as-is; scores are only strictly
    # comparable within one model, but COSINE keeps them on the same [0,1]-ish scale.
    for (group_model_type, group_model_name), collection_names in grouped.items():
        logger.info("Node retrieval: embedding query with model_type=%s model_name=%s for %d collection(s)", group_model_type, group_model_name, len(collection_names))
        encoder = _get_cached_embedding_model(group_model_type, group_model_name)
        query_embeddings = create_embeddings([query], encoder)
        if not query_embeddings:
            count("embedding_failure_total", source="retrieve", model=group_model_name)
            logger.error("Node retrieval: embedding creation returned empty result for model %s/%s", group_model_type, group_model_name)
            continue

        query_vector = query_embeddings[0].get("vector")
        logger.info("Node retrieval: query embedded, vector_dim=%d", len(query_vector or []))

        for collection_name in collection_names:
            logger.info("Node retrieval: searching collection '%s' (top_n=%d threshold=%.2f)", collection_name, top_n, similarity_threshold)
            search_res = client.search(
                collection_name=collection_name,
                data=[query_vector],
                limit=top_n,
                search_params=search_params,
                output_fields=["note_value", "title", "subject", "client", "custom_topic", "custom_resolution"],
            )

            hits_found = 0
            hits_discarded = 0
            for hits in search_res:
                for hit in hits:
                    distance = hit.get("distance", 0.0)
                    if distance >= similarity_threshold:
                        hits_found += 1
                        all_results.append({
                            "id": hit.get("id"),
                            "distance": distance,
                            "entity": hit.get("entity", {}),
                            "source_collection": collection_name,
                        })
                    else:
                        hits_discarded += 1
                        logger.debug("Node retrieval: discarding hit id=%s distance=%.4f < threshold=%.2f", hit.get("id"), distance, similarity_threshold)

            logger.info("Node retrieval: collection '%s' — %d hits kept, %d discarded", collection_name, hits_found, hits_discarded)

    all_results.sort(key=lambda x: x["distance"], reverse=True)
    top_results = all_results[:top_n]
    logger.info("Node retrieval: END — %d total results returned", len(top_results))
    return top_results
