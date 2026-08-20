import logging
from typing import Dict, Any, List, Tuple

from handlers.store_embeddings_lambda import handler as store_embeddings_handler

logger = logging.getLogger()


def store_batch_results(
    batches: List[Dict[str, Any]],
    vectors_by_id: Dict[str, List[float]],
    context: Any,
) -> Tuple[int, int]:
    """
    Map Voyage batch results back onto their chunks and store each batch via the
    same store-embeddings logic the realtime path uses.

    custom_id scheme (from voyage_batch.build_embeddings_jsonl) is "b{bi}c{ci}",
    i.e. batch index + chunk index. Returns (stored_batches, missing_chunks).
    """
    stored_batches = 0
    missing_chunks = 0
    for bi, batch_state in enumerate(batches):
        chunks = batch_state.get("data_chunks") or []
        embeddings = []
        for ci, chunk_text in enumerate(chunks):
            vector = vectors_by_id.get(f"b{bi}c{ci}")
            if vector is None:
                missing_chunks += 1
                logger.warning(f"No embedding returned for chunk b{bi}c{ci}; skipping it.")
                continue
            embeddings.append({"text": chunk_text, "vector": vector, "index": ci})

        if not embeddings:
            continue

        # Same payload shape create_embeddings_lambda produces for the realtime path
        store_embeddings_handler({**batch_state, "data_chunks": [], "vectors": embeddings}, context)
        stored_batches += 1

    return stored_batches, missing_chunks
