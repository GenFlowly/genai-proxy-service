"""Pipeline text lives in its source table, never in pipeline messages.

SQS bodies, Step Functions inputs and outputs, and dead-letter messages carry
only the keys of the item being indexed (to_pointer_state). The lambdas that
need the text read it from the table that owns it (load_raw_data) and keep it
in memory, so queues, workflow history and execution logs never hold chat,
note, instruction or memory text. EMAIL has no source table, so its payload
still travels whole.

The keys in a message come from the authenticated caller's request, so every
lookup is scoped to that customer: notes and memories by their partition key,
instructions by creator, conversations by message author or conversation
owner. A key that resolves to someone else's data loads nothing.
"""
import hashlib
import logging
import os
from typing import Any, Dict, Optional

import boto3

from encoding_library.models.memory_request_internal_state import MemoryRequestInternalState

logger = logging.getLogger()

# Same per-side cap as genai-proxy-server's ConversationIndexingService, so a
# reloaded exchange is the text the proxy used to send.
MAX_EXCHANGE_SIDE_CHARS = 30_000

# The only raw_data keys a pipeline message may carry: record keys and
# timestamps. Everything else is reloaded from the source table.
_POINTER_FIELDS = {
    "NOTE": ("note_key", "noteKey", "note_id", "notes_id", "created_at", "createdAt"),
    "CONVERSATION": (
        "conversation_key", "conversationKey", "message_key", "messageKey", "created_at", "createdAt",
    ),
    "INSTRUCTION": ("instruction_id", "instructionId", "version", "created_at", "createdAt"),
    "MEMORY": ("memory_key", "memoryKey", "created_at", "createdAt"),
}

_dynamodb = None


def _table_name(env_var: str, default: str) -> str:
    return os.environ.get(env_var) or default


def _get_item(table_name: str, key: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Strongly consistent GetItem: the proxy writes the row moments before
    the pipeline reads it."""
    global _dynamodb
    if _dynamodb is None:
        _dynamodb = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    return _dynamodb.Table(table_name).get_item(Key=key, ConsistentRead=True).get("Item")


def is_source_backed(data_type: Optional[str]) -> bool:
    return (data_type or "").upper() in _POINTER_FIELDS


def to_pointer_state(state: Dict[str, Any]) -> Dict[str, Any]:
    """A copy of a serialized MemoryRequestInternalState with its text removed:
    raw_data keeps only record keys and timestamps, and chunks and vectors are
    dropped. Types without a source table are returned unchanged."""
    fields = _POINTER_FIELDS.get((state.get("data_type") or "").upper())
    if fields is None:
        return state
    raw_data = state.get("raw_data") or {}
    pointer = dict(state)
    pointer["raw_data"] = {k: raw_data[k] for k in fields if k in raw_data}
    pointer["data_chunks"] = None
    pointer["vectors"] = None
    return pointer


def content_sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _first(raw_data: Dict[str, Any], *keys: str) -> Optional[Any]:
    for key in keys:
        value = raw_data.get(key)
        if value not in (None, ""):
            return value
    return None


def load_raw_data(state: MemoryRequestInternalState) -> Optional[Dict[str, Any]]:
    """The full raw_data for the item a pointer message names, read from its
    source table; None when the item no longer exists, was deleted, or doesn't
    belong to the message's customer. Callers skip the item on None."""
    data_type = (state.data_type or "").upper()
    customer_id = state.customer_id
    raw_data = state.raw_data or {}
    if not customer_id:
        raise ValueError("customer_id is missing from the payload")

    if data_type == "NOTE":
        return _load_note(customer_id, raw_data)
    if data_type == "CONVERSATION":
        return _load_conversation(customer_id, raw_data)
    if data_type == "INSTRUCTION":
        return _load_instruction(customer_id, raw_data)
    if data_type == "MEMORY":
        return _load_memory(customer_id, raw_data)
    raise ValueError(f"data_type '{state.data_type}' has no source table")


def _load_note(customer_id: str, raw_data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    note_key = _first(raw_data, "note_key", "noteKey", "note_id")
    if not note_key:
        raise ValueError("note_key is missing from the payload")
    item = _get_item(
        _table_name("CUSTOMER_NOTES_TABLE", "CustomerNotes"),
        {"customerId": customer_id, "noteKey": note_key},
    )
    if not item or item.get("is_delete") is True:
        logger.info("Note %s of customer %s is gone or deleted; not indexing", note_key, customer_id)
        return None
    loaded = {
        "note_key": note_key,
        "note_value": item.get("noteValue") or "",
        "title": item.get("title"),
        "created_at": _first(raw_data, "created_at", "createdAt")
        or item.get("noteCreatedAt") or item.get("createdAt") or "",
    }
    notes_id = _first(raw_data, "notes_id")
    if notes_id:
        loaded["notes_id"] = notes_id
    return loaded


def _load_conversation(customer_id: str, raw_data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    conversation_key = _first(raw_data, "conversation_key", "conversationKey")
    message_key = _first(raw_data, "message_key", "messageKey")
    if not conversation_key or not message_key:
        raise ValueError("conversation_key and message_key are required")
    message_table = _table_name("MESSAGE_TABLE", "Message")
    assistant = _get_item(message_table, {"conversationId": conversation_key, "messageId": message_key})
    if not assistant:
        logger.info("Message %s of conversation %s is gone; not indexing", message_key, conversation_key)
        return None
    # The author covers a share recipient's own turns; ownership covers forks,
    # whose copied rows keep the original author.
    if assistant.get("customerId") != customer_id and not _get_item(
        _table_name("CONVERSATION_TABLE", "Conversation"),
        {"customerId": customer_id, "conversationId": conversation_key},
    ):
        logger.warning(
            "Message %s of conversation %s belongs to neither customer %s nor a conversation they own; not indexing",
            message_key, conversation_key, customer_id,
        )
        return None
    previous_id = assistant.get("previousMessageId")
    user = (
        _get_item(message_table, {"conversationId": conversation_key, "messageId": previous_id})
        if previous_id else None
    )
    user_text = (user or {}).get("text") or ""
    assistant_text = assistant.get("text") or ""
    return {
        "conversation_key": conversation_key,
        "message_key": message_key,
        "text": (
            f"User: {user_text[:MAX_EXCHANGE_SIDE_CHARS]}\n"
            f"Assistant: {assistant_text[:MAX_EXCHANGE_SIDE_CHARS]}"
        ),
        "title": "",
        "created_at": _first(raw_data, "created_at", "createdAt") or assistant.get("createdAt") or "",
    }


def _load_instruction(customer_id: str, raw_data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    instruction_id = _first(raw_data, "instruction_id", "instructionId")
    if not instruction_id:
        raise ValueError("instruction_id is missing from the payload")
    version = int(raw_data.get("version") or 1)
    item = _get_item(
        _table_name("INSTRUCTIONS_TABLE", "Instructions"),
        {"instructionId": instruction_id, "version": version},
    )
    if not item:
        logger.info("Instruction %s v%s is gone; not indexing", instruction_id, version)
        return None
    if item.get("creator") != customer_id:
        logger.warning(
            "Instruction %s was not created by customer %s; not indexing", instruction_id, customer_id
        )
        return None
    tags = item.get("tags")
    return {
        "instruction_id": instruction_id,
        "version": version,
        "name": item.get("name"),
        "instructions": item.get("instructions") or "",
        "category": item.get("category"),
        "tags": list(tags) if tags else None,
        "created_at": _first(raw_data, "created_at", "createdAt") or item.get("createdAt") or "",
    }


def _load_memory(customer_id: str, raw_data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    memory_key = _first(raw_data, "memory_key", "memoryKey")
    if not memory_key:
        raise ValueError("memory_key is missing from the payload")
    item = _get_item(
        _table_name("CUSTOMER_MEMORY_TABLE", "CustomerMemory"),
        {"customerId": customer_id, "memoryId": memory_key},
    )
    if not item:
        logger.info("Memory %s of customer %s is gone; not indexing", memory_key, customer_id)
        return None
    # Same title genai-proxy-server's MemoryExtractionService gives a memory vector.
    label = item.get("category") or (item.get("kind") or "episodic").lower()
    return {
        "memory_key": memory_key,
        "memory_value": item.get("text") or "",
        "title": f"[memory] {label}",
        "created_at": _first(raw_data, "created_at", "createdAt") or item.get("createdAt") or "",
    }
