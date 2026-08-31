import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from encoding_library.utils.vector_db import get_milvus_client

logger = logging.getLogger(__name__)

router = APIRouter()


class DeleteNoteVectorsRequest(BaseModel):
    customer_id: str
    note_key: str


class DeleteMemoryVectorsRequest(BaseModel):
    customer_id: str
    memory_key: str


def _escape_filter_value(value: str) -> str:
    """Escape a string for safe interpolation into a Milvus filter expression."""
    return value.replace("\\", "\\\\").replace('"', '\\"')


@router.post("/delete-note-vectors")
async def delete_note_vectors(req: DeleteNoteVectorsRequest):
    """
    Hard-delete every vector chunk of a note from the customer's vector DB.

    Note collections have historically been named both '{customer_id}_notes'
    and '{customer_id}_notes_{model_name}', so the note is deleted from every
    collection carrying the '{customer_id}_notes' prefix.
    """
    if not req.customer_id or not req.note_key:
        raise HTTPException(status_code=400, detail="customer_id and note_key are required")

    logger.info("Deleting note vectors — customer=%s note_key=%s", req.customer_id, req.note_key)

    try:
        client = get_milvus_client(req.customer_id)
        notes_prefix = f"{req.customer_id}_notes"
        note_filter = f'note_key == "{_escape_filter_value(req.note_key)}"'

        deleted_counts: dict[str, int] = {}
        for collection_name in client.list_collections():
            if not collection_name.startswith(notes_prefix):
                continue
            result = client.delete(collection_name=collection_name, filter=note_filter)
            # MilvusClient.delete returns {'delete_count': n} (dict-like)
            delete_count = result.get("delete_count", 0) if hasattr(result, "get") else 0
            deleted_counts[collection_name] = delete_count
            logger.info(
                "Deleted %s vectors for note_key=%s from collection '%s'",
                delete_count, req.note_key, collection_name,
            )

        if not deleted_counts:
            logger.info("No note collections found for customer %s; nothing to delete", req.customer_id)

        return {"status": "success", "deleted": deleted_counts}
    except Exception as e:
        logger.error("Failed to delete note vectors for customer=%s note_key=%s: %s",
                     req.customer_id, req.note_key, e, exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to delete note vectors")


@router.post("/delete-memory-vectors")
async def delete_memory_vectors(req: DeleteMemoryVectorsRequest):
    """
    Hard-delete every vector chunk of a user memory from the customer's vector
    DB. Memory collections are named '{customer_id}_memory_{model_name}'.
    """
    if not req.customer_id or not req.memory_key:
        raise HTTPException(status_code=400, detail="customer_id and memory_key are required")

    logger.info("Deleting memory vectors — customer=%s memory_key=%s", req.customer_id, req.memory_key)

    try:
        client = get_milvus_client(req.customer_id)
        memory_prefix = f"{req.customer_id}_memory"
        memory_filter = f'memory_key == "{_escape_filter_value(req.memory_key)}"'

        deleted_counts: dict[str, int] = {}
        for collection_name in client.list_collections():
            if not collection_name.startswith(memory_prefix):
                continue
            result = client.delete(collection_name=collection_name, filter=memory_filter)
            delete_count = result.get("delete_count", 0) if hasattr(result, "get") else 0
            deleted_counts[collection_name] = delete_count
            logger.info(
                "Deleted %s vectors for memory_key=%s from collection '%s'",
                delete_count, req.memory_key, collection_name,
            )

        if not deleted_counts:
            logger.info("No memory collections found for customer %s; nothing to delete", req.customer_id)

        return {"status": "success", "deleted": deleted_counts}
    except Exception as e:
        logger.error("Failed to delete memory vectors for customer=%s memory_key=%s: %s",
                     req.customer_id, req.memory_key, e, exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to delete memory vectors")
