"""Knowledge-search hits the customer can still see.

A chunk can outlive its source in the vector DB: a delete that hasn't
reached the customer's cluster yet, or rows from before deletes were
permanent (archived conversations, soft-deleted notes). So every
conversation and note hit is checked against its DynamoDB row, the source
of truth, before it can reach a prompt. Email has no source table and
passes through.
"""
import logging
import os
import time
from typing import Optional

import boto3
from encoding_library.utils.vector_db import collection_data_type

logger = logging.getLogger(__name__)

CONVERSATION_TABLE_NAME = os.environ.get("CONVERSATION_TABLE", "Conversation")
NOTES_TABLE_NAME = os.environ.get("CUSTOMER_NOTES_TABLE", "CustomerNotes")

# BatchGetItem's per-request key limit.
_BATCH_SIZE = 100
_UNPROCESSED_RETRIES = 5

_dynamodb = None


def _resource():
    global _dynamodb
    if _dynamodb is None:
        _dynamodb = boto3.resource("dynamodb", region_name=os.getenv("AWS_REGION", "us-east-1"))
    return _dynamodb


def _source_key(result: dict) -> tuple[Optional[str], Optional[str]]:
    """(data type, source key) of a hit, from its collection and stored fields."""
    data_type = collection_data_type(result.get("source_collection") or "")
    entity = result.get("entity") or {}
    if data_type == "conversation":
        return data_type, entity.get("conversation_key")
    if data_type == "notes":
        return data_type, entity.get("note_key")
    return data_type, None


def _batch_get(dynamodb, table: str, keys: list[dict], projection: str, names: dict) -> list[dict]:
    items: list[dict] = []
    for start in range(0, len(keys), _BATCH_SIZE):
        request = {table: {"Keys": keys[start:start + _BATCH_SIZE], "ProjectionExpression": projection,
                           "ExpressionAttributeNames": names, "ConsistentRead": True}}
        for attempt in range(_UNPROCESSED_RETRIES + 1):
            response = dynamodb.batch_get_item(RequestItems=request)
            items.extend(response.get("Responses", {}).get(table, []))
            request = response.get("UnprocessedKeys") or {}
            if not request:
                break
            if attempt == _UNPROCESSED_RETRIES:
                raise RuntimeError(f"DynamoDB left keys of {table} unprocessed")
            time.sleep(0.05 * (2 ** attempt))
    return items


def _visible_conversations(dynamodb, customer_id: str, keys: set[str]) -> set[str]:
    if not keys:
        return set()
    rows = _batch_get(
        dynamodb, CONVERSATION_TABLE_NAME,
        [{"customerId": customer_id, "conversationId": key} for key in sorted(keys)],
        "#id, #archived", {"#id": "conversationId", "#archived": "archivedAt"},
    )
    return {row["conversationId"] for row in rows if not row.get("archivedAt")}


def _visible_notes(dynamodb, customer_id: str, keys: set[str]) -> set[str]:
    if not keys:
        return set()
    rows = _batch_get(
        dynamodb, NOTES_TABLE_NAME,
        [{"customerId": customer_id, "noteKey": key} for key in sorted(keys)],
        "#key, #deleted", {"#key": "noteKey", "#deleted": "is_delete"},
    )
    return {row["noteKey"] for row in rows if row.get("is_delete") is not True}


def visible_results(customer_id: str, results: list[dict], dynamodb=None) -> list[dict]:
    """The hits whose conversation or note still exists, belongs to the
    customer and isn't archived or soft-deleted. A conversation or note hit
    without its key is dropped: it can't be checked. Raises when DynamoDB
    can't answer, so nothing unchecked is returned."""
    typed = [(result, *_source_key(result)) for result in results]
    if all(data_type not in ("conversation", "notes") for _, data_type, _ in typed):
        return results
    conversation_keys = {key for _, data_type, key in typed if data_type == "conversation" and key}
    note_keys = {key for _, data_type, key in typed if data_type == "notes" and key}

    dynamodb = dynamodb or _resource()
    visible = {
        "conversation": _visible_conversations(dynamodb, customer_id, conversation_keys),
        "notes": _visible_notes(dynamodb, customer_id, note_keys),
    }
    kept = [
        result for result, data_type, key in typed
        if data_type not in visible or key in visible[data_type]
    ]
    if len(kept) < len(results):
        logger.info(
            "Knowledge search: dropped %d hit(s) of deleted or archived items (customer=%s)",
            len(results) - len(kept), customer_id,
        )
    return kept
