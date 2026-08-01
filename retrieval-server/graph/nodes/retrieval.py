import logging
from typing import Any

from pymilvus import MilvusClient

from encoding_library.utils.embedding_utils import create_embeddings, get_embedding_model
from encoding_library.utils.vector_db import get_zilliz_credentials
from graph.state import RetrievalState

logger = logging.getLogger(__name__)

_embedding_model_cache: dict[tuple[str, str], Any] = {}


def _get_cached_embedding_model(model_type: str | None, model_name: str | None) -> Any:
    key = (model_type or "sentence-transformer", model_name or "all-MiniLM-L6-v2")
    if key not in _embedding_model_cache:
        logger.info("Loading embedding model type=%s name=%s (first time)", key[0], key[1])
        _embedding_model_cache[key] = get_embedding_model(model_type, model_name)
    return _embedding_model_cache[key]


async def retrieval(state: RetrievalState) -> dict:
    query = state.get("rewritten_query") or state["original_query"]
    customer_id = state["customer_id"]
    logger.info("Node retrieval: START — customer=%s query='%s'", customer_id, query[:100])

    try:
        config = state.get("node_configs", {}).get("RETRIEVAL", {})
        top_n = config.get("top_n") or state["top_n"]
        similarity_threshold = config.get("similarity_threshold") or state["similarity_threshold"]
        search_params = config.get("search_params") or state["search_params"]

        logger.info("Node retrieval: creating embeddings (model_type=%s model_name=%s)", state.get("model_type"), state.get("model_name"))
        encoder = _get_cached_embedding_model(state.get("model_type"), state.get("model_name"))
        query_embeddings = create_embeddings([query], encoder)
        if not query_embeddings:
            logger.error("Node retrieval: embedding creation returned empty result")
            return {"retrieval_results": [], "error": "Failed to create embeddings"}
        logger.info("Node retrieval: embeddings created, vector_dim=%d", len(query_embeddings[0].get("vector", [])))

        query_vector = query_embeddings[0].get("vector")

        logger.info("Node retrieval: connecting to Zilliz for customer=%s", customer_id)
        zilliz_endpoint, zilliz_token = get_zilliz_credentials(customer_id)
        client = MilvusClient(uri=zilliz_endpoint, token=zilliz_token)
        logger.info("Node retrieval: connected to Zilliz")

        collection_names = [customer_id, f"{customer_id}_notes"]
        all_results = []

        for collection_name in collection_names:
            if not client.has_collection(collection_name):
                logger.warning("Node retrieval: collection '%s' does not exist, skipping", collection_name)
                continue

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
        return {"retrieval_results": top_results}

    except Exception as e:
        logger.error("Node retrieval: FAILED — %s", e, exc_info=True)
        return {"retrieval_results": [], "error": str(e)}
