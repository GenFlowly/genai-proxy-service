"""
The proxy's VectorSyncPending registry holds one row per record that is saved
but not yet in the customer's vector DB, so search can keyword-match it in the
meantime. Once a record's vectors are stored, its row goes.
"""
import logging
import os
from typing import Any, Dict, Optional

from encoding_library.observability import count

logger = logging.getLogger()

# data_type -> (registry type token, raw_data fields that carry the record key)
_REGISTRY_KEYS = {
    "CONVERSATION": ("conversation", ("message_key", "messageKey")),
    "NOTE": ("notes", ("note_key", "noteKey", "note_id")),
}


def registry_item_key(data_type: str, raw_data: Dict[str, Any]) -> Optional[str]:
    entry = _REGISTRY_KEYS.get(data_type)
    if entry is None:
        return None
    type_token, fields = entry
    key = next((raw_data.get(f) for f in fields if raw_data.get(f)), None)
    return f"{type_token}#{key}" if key else None


def clear_pending(customer_id: str, data_type: str, raw_data: Optional[Dict[str, Any]], dynamodb=None) -> None:
    """
    Deletes the record's registry row. Never raises: the vectors ARE stored,
    and a row left behind only costs a redundant keyword match (deduplicated
    against the vector hit) and one proxy retry, which re-encodes idempotently.
    """
    item_key = registry_item_key(data_type, raw_data or {})
    if item_key is None:
        return
    try:
        if dynamodb is None:
            import boto3
            dynamodb = boto3.client("dynamodb", region_name=os.getenv("AWS_REGION", "us-east-1"))
        dynamodb.delete_item(
            TableName=os.getenv("VECTOR_SYNC_PENDING_TABLE", "VectorSyncPending"),
            Key={"customerId": {"S": customer_id}, "itemKey": {"S": item_key}},
        )
    except Exception as e:
        count("vector_store_ddb_writeback_failure_total", data_type=f"{data_type}_PENDING")
        logger.error(f"Failed to clear vector-sync-pending row {item_key}: {str(e)}")
