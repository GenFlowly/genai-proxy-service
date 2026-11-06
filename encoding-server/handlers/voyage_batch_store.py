import logging
import os
from typing import Dict, Any, List, Tuple

import boto3

from handlers.store_embeddings_lambda import handler as store_embeddings_handler

logger = logging.getLogger()

_dynamodb = None


def _note_exists(customer_id: str, note_key: str) -> bool:
    """Whether the note still exists and isn't soft-deleted. A Voyage batch
    can finish hours after a note in it was deleted; its vectors must not be
    stored then."""
    global _dynamodb
    if _dynamodb is None:
        _dynamodb = boto3.client("dynamodb", region_name=os.getenv("AWS_REGION", "us-east-1"))
    item = _dynamodb.get_item(
        TableName=os.getenv("CUSTOMER_NOTES_TABLE", "CustomerNotes"),
        Key={"customerId": {"S": customer_id}, "noteKey": {"S": note_key}},
        ProjectionExpression="noteKey, is_delete",
        ConsistentRead=True,
    ).get("Item")
    return bool(item) and not item.get("is_delete", {}).get("BOOL", False)


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
        raw = batch_state.get("raw_data") or {}
        note_key = raw.get("note_key") or raw.get("noteKey")
        customer_id = batch_state.get("customer_id")
        if batch_state.get("data_type") == "NOTE" and note_key and customer_id and not _note_exists(customer_id, note_key):
            logger.info(f"Note {note_key} was deleted while its batch ran; not storing its vectors")
            continue
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
