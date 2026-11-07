import logging
import re
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from encoding_library.observability import count
from encoding_library.utils.model_registry import build_collection_description, resolve_model
from encoding_library.utils.vector_db import (
    CUSTOMER_ID_MAX_LENGTH,
    VectorDBNotConfigured,
    add_customer_id_field,
    collection_data_type,
    customer_filter,
    ensure_collection,
    get_milvus_client,
    shared_collection_name,
)

logger = logging.getLogger(__name__)

# Customer ids are generated ids; anything else could widen the legacy
# '{customer_id}_' collection prefix to other tenants' collections.
CUSTOMER_ID_PATTERN = re.compile(r"[A-Za-z0-9-]{1,64}")

router = APIRouter()


class DeleteNoteVectorsRequest(BaseModel):
    customer_id: str
    note_key: str


class DeleteMemoryVectorsRequest(BaseModel):
    customer_id: str
    memory_key: str


class EncodeMemoryRequest(BaseModel):
    customer_id: str
    memory_key: str
    memory_value: str
    title: str = ""
    client: str = "memory"
    created_at: str = ""
    model_type: Optional[str] = None
    model_name: Optional[str] = None


class EncodeConversationRequest(BaseModel):
    customer_id: str
    conversation_key: str
    message_key: str
    text: str
    title: str = ""
    client: str = "web"
    created_at: str = ""
    model_type: Optional[str] = None
    model_name: Optional[str] = None


class DeleteInstructionVectorsRequest(BaseModel):
    customer_id: str
    instruction_key: str


class DeleteConversationVectorsRequest(BaseModel):
    customer_id: str
    conversation_key: str


class DeleteCustomerVectorsRequest(BaseModel):
    customer_id: str


def _escape_filter_value(value: str) -> str:
    """Escape a string for safe interpolation into a Milvus filter expression."""
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _tenant_scoped_collections(client, customer_id: str, type_token: str, legacy_prefix: str):
    """Yield (collection_name, filter_scope) pairs a tenant's delete must sweep:
    shared '{type}_{model}' collections (rows scoped by the customer_id
    partition key) plus any legacy per-customer '{legacy_prefix}*' collections
    (single-tenant by naming, no customer_id field — remove this branch once
    they are migrated and dropped)."""
    for collection_name in client.list_collections():
        if collection_data_type(collection_name) == type_token:
            yield collection_name, True
        elif collection_name.startswith(legacy_prefix):
            yield collection_name, False


@router.post("/delete-note-vectors")
async def delete_note_vectors(req: DeleteNoteVectorsRequest):
    """
    Hard-delete every vector chunk of a note from the vector DB: the shared
    'notes_{model}' collections (scoped to the customer's rows) plus any
    not-yet-migrated legacy '{customer_id}_notes*' collections.
    """
    if not req.customer_id or not req.note_key:
        raise HTTPException(status_code=400, detail="customer_id and note_key are required")

    logger.info("Deleting note vectors — customer=%s note_key=%s", req.customer_id, req.note_key)

    try:
        client = get_milvus_client(req.customer_id)
        note_filter = f'note_key == "{_escape_filter_value(req.note_key)}"'

        deleted_counts: dict[str, int] = {}
        for collection_name, shared in _tenant_scoped_collections(
            client, req.customer_id, "notes", f"{req.customer_id}_notes"
        ):
            scoped = customer_filter(req.customer_id, note_filter) if shared else note_filter
            result = client.delete(collection_name=collection_name, filter=scoped)
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
    except VectorDBNotConfigured:
        # No vector DB means nothing was ever stored — deletion is a no-op.
        logger.info("No vector DB configured for customer %s; nothing to delete", req.customer_id)
        return {"status": "success", "deleted": {}}
    except Exception as e:
        logger.error("Failed to delete note vectors for customer=%s note_key=%s: %s",
                     req.customer_id, req.note_key, e, exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to delete note vectors")


def _memory_collection_schema(dim: int, description: str):
    """Milvus schema + index for a memory collection.

    MIRRORS encoding_library.processors.memory_processor.MemoryProcessor
    .get_collection_schema — keep the two in sync. (The processor can't be
    imported here: it reaches for the encoding-server's `models.encoding`
    package, which this server doesn't ship.) Field names deliberately match
    NoteProcessor's (note_value/title/client/created_at) so retrieval's fixed
    output_fields list surfaces memory hits; memory_key is the deletion and
    DDB-join handle.
    """
    # Lazy import: pymilvus must not be a price of importing this module.
    from pymilvus import DataType, MilvusClient

    schema = MilvusClient.create_schema(auto_id=False, enable_dynamic_field=True, description=description)
    schema.add_field(field_name="id", datatype=DataType.VARCHAR, max_length=256, is_primary=True)
    schema.add_field(field_name="vector", datatype=DataType.FLOAT_VECTOR, dim=dim)
    schema.add_field(field_name="note_value", datatype=DataType.VARCHAR, max_length=65535)
    schema.add_field(field_name="title", datatype=DataType.VARCHAR, max_length=512)
    schema.add_field(field_name="memory_key", datatype=DataType.VARCHAR, max_length=256)
    schema.add_field(field_name="client", datatype=DataType.VARCHAR, max_length=100)
    schema.add_field(field_name="created_at", datatype=DataType.VARCHAR, max_length=64)
    add_customer_id_field(schema)

    index_params = MilvusClient.prepare_index_params()
    index_params.add_index(field_name="vector", index_type="AUTOINDEX", metric_type="COSINE")
    return schema, index_params


@router.post("/encode-memory")
async def encode_memory(req: EncodeMemoryRequest):
    """
    Embed one user memory and upsert it into the shared 'memory_{model}'
    collection (created on first use), stamped with the customer's
    customer_id partition key.

    This is the realtime write path for memory vectors, replacing the
    encoding-server's /encode-memories for memories: that path requires the
    end user's bearer token, which retries from the proxy's extraction
    reconciler don't have — this server already holds the embedding key and
    the Zilliz connection (it embeds recall queries), so the call is
    service-to-service. Memories are single sentences: always exactly one
    chunk, no batch accumulation.

    Idempotent: existing vectors for the memory_key are deleted before the
    insert (Milvus insert does not upsert on duplicate PKs), so re-encodes —
    extraction retries, UPDATE operations — never strand stale rows.
    """
    if not req.customer_id or not req.memory_key or not req.memory_value.strip():
        raise HTTPException(
            status_code=400,
            detail="customer_id, memory_key and memory_value are required",
        )

    # Lazy import: pulls in the embedding stack, which module import (and the
    # route-less unit tests) must not pay for.
    from encoding_library.utils.embedding_utils import EmbeddingKeyMissing, create_embeddings
    from graph.nodes.retrieval import customer_embedding_model

    model_type, model_name = resolve_model(req.model_type, req.model_name)
    collection_name = shared_collection_name("memory", model_name)
    logger.info(
        "Encoding memory — customer=%s memory_key=%s collection=%s",
        req.customer_id, req.memory_key, collection_name,
    )

    try:
        # The vector DB first: without one the text has nowhere to go, so it
        # is never sent to the embedding provider.
        client = get_milvus_client(req.customer_id)
        encoder = customer_embedding_model(req.customer_id, model_type, model_name)
        embeddings = create_embeddings([req.memory_value], encoder, customer_id=req.customer_id)
        if not embeddings or not embeddings[0].get("vector"):
            count("embedding_failure_total", source="encode_memory", model=model_name)
            raise RuntimeError(f"embedding returned no vector (model {model_type}/{model_name})")
        vector = embeddings[0]["vector"]

        schema, index_params = _memory_collection_schema(
            dim=len(vector),
            description=build_collection_description(model_type, model_name, len(vector)),
        )
        if ensure_collection(client, collection_name, schema, index_params):
            logger.info("Created memory collection '%s' (dim=%d)", collection_name, len(vector))

        client.delete(
            collection_name=collection_name,
            filter=customer_filter(
                req.customer_id, f'memory_key == "{_escape_filter_value(req.memory_key)}"'
            ),
        )
        record = {
            "id": f"{req.memory_key}_0",
            "customer_id": req.customer_id[:CUSTOMER_ID_MAX_LENGTH],
            "vector": vector,
            "note_value": req.memory_value[:65535],
            "title": (req.title or "")[:500],
            "memory_key": req.memory_key[:256],
            "client": (req.client or "memory")[:100],
            "created_at": req.created_at or datetime.now(timezone.utc).isoformat(),
        }
        result = client.insert(collection_name=collection_name, data=[record])
        client.flush(collection_name=collection_name)
        count("vector_store_chunks_total", result.get("insert_count", 1), data_type="MEMORY")
        return {"status": "success", "collection": collection_name}
    except HTTPException:
        raise
    except (EmbeddingKeyMissing, VectorDBNotConfigured) as e:
        # Customer state, not an infrastructure failure — 409 so the caller's
        # retry machinery treats it as permanent rather than retrying a 500.
        logger.warning(
            "Cannot encode memory for customer=%s: %s", req.customer_id, e
        )
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        logger.error(
            "Failed to encode memory for customer=%s memory_key=%s: %s",
            req.customer_id, req.memory_key, e, exc_info=True,
        )
        raise HTTPException(status_code=500, detail="Failed to encode memory")


def _conversation_collection_schema(dim: int, description: str):
    """Milvus schema + index for a conversation collection.

    MIRRORS encoding_library.processors.conversation_processor
    .ConversationProcessor.get_collection_schema — keep the two in sync (same
    import constraint as _memory_collection_schema).
    """
    from pymilvus import DataType, MilvusClient

    schema = MilvusClient.create_schema(auto_id=False, enable_dynamic_field=True, description=description)
    schema.add_field(field_name="id", datatype=DataType.VARCHAR, max_length=256, is_primary=True)
    schema.add_field(field_name="vector", datatype=DataType.FLOAT_VECTOR, dim=dim)
    schema.add_field(field_name="note_value", datatype=DataType.VARCHAR, max_length=65535)
    schema.add_field(field_name="title", datatype=DataType.VARCHAR, max_length=512)
    schema.add_field(field_name="conversation_key", datatype=DataType.VARCHAR, max_length=256)
    schema.add_field(field_name="message_key", datatype=DataType.VARCHAR, max_length=256)
    schema.add_field(field_name="client", datatype=DataType.VARCHAR, max_length=100)
    schema.add_field(field_name="created_at", datatype=DataType.VARCHAR, max_length=64)
    add_customer_id_field(schema)

    index_params = MilvusClient.prepare_index_params()
    index_params.add_index(field_name="vector", index_type="AUTOINDEX", metric_type="COSINE")
    return schema, index_params


@router.post("/encode-conversation")
async def encode_conversation(req: EncodeConversationRequest):
    """
    Embed one user/assistant exchange into the shared 'conversation_{model}'
    collection, producing the same rows as the encoding-server pipeline
    (ConversationProcessor): chunk ids '{message_key}_{i}', chunk text in
    note_value.

    The proxy's retry path for exchanges whose pipeline embed never landed:
    the pipeline needs the end user's bearer token, which a later retry
    doesn't have; this call is service-to-service, like /encode-memory.

    Idempotent: the exchange's existing chunks are deleted before the insert,
    so a retry after a pipeline write that did land replaces rather than
    duplicates.
    """
    if not req.customer_id or not req.conversation_key or not req.message_key or not req.text.strip():
        raise HTTPException(
            status_code=400,
            detail="customer_id, conversation_key, message_key and text are required",
        )

    from encoding_library.utils.embedding_utils import EmbeddingKeyMissing, create_chunks, create_embeddings
    from encoding_library.utils.model_registry import get_chunking_params
    from graph.nodes.retrieval import customer_embedding_model

    model_type, model_name = resolve_model(req.model_type, req.model_name)
    collection_name = shared_collection_name("conversation", model_name)
    logger.info(
        "Encoding conversation exchange — customer=%s message_key=%s collection=%s",
        req.customer_id, req.message_key, collection_name,
    )

    try:
        # The vector DB first: without one the text has nowhere to go, so it
        # is never sent to the embedding provider.
        client = get_milvus_client(req.customer_id)
        chunk_size, chunk_overlap = get_chunking_params(model_type, model_name)
        chunks = create_chunks(req.text, None, chunk_size=chunk_size, chunk_overlap=chunk_overlap)
        encoder = customer_embedding_model(req.customer_id, model_type, model_name)
        embeddings = create_embeddings(chunks, encoder, customer_id=req.customer_id)
        if not embeddings or any(not e.get("vector") for e in embeddings):
            count("embedding_failure_total", source="encode_conversation", model=model_name)
            raise RuntimeError(f"embedding returned no vector (model {model_type}/{model_name})")

        dim = len(embeddings[0]["vector"])
        schema, index_params = _conversation_collection_schema(
            dim=dim,
            description=build_collection_description(model_type, model_name, dim),
        )
        if ensure_collection(client, collection_name, schema, index_params):
            logger.info("Created conversation collection '%s' (dim=%d)", collection_name, dim)

        client.delete(
            collection_name=collection_name,
            filter=customer_filter(
                req.customer_id, f'message_key == "{_escape_filter_value(req.message_key)}"'
            ),
        )
        created_at = req.created_at or datetime.now(timezone.utc).isoformat()
        records = [
            {
                "id": f"{req.message_key}_{i}",
                "customer_id": req.customer_id[:CUSTOMER_ID_MAX_LENGTH],
                "vector": chunk["vector"],
                "note_value": chunk["text"][:65535],
                "title": (req.title or "")[:500],
                "conversation_key": req.conversation_key[:256],
                "message_key": req.message_key[:256],
                "client": (req.client or "web")[:100],
                "created_at": created_at,
            }
            for i, chunk in enumerate(embeddings)
        ]
        # No flush: the cluster allows ~1 flush per 20s in total and reads see
        # growing segments (see the encoding-server store step).
        result = client.insert(collection_name=collection_name, data=records)
        count("vector_store_chunks_total", result.get("insert_count", len(records)), data_type="CONVERSATION")
        return {"status": "success", "collection": collection_name, "chunks": len(records)}
    except HTTPException:
        raise
    except (EmbeddingKeyMissing, VectorDBNotConfigured) as e:
        # Customer state — 409 so the proxy's retry treats it as permanent.
        logger.warning("Cannot encode conversation for customer=%s: %s", req.customer_id, e)
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        logger.error(
            "Failed to encode conversation for customer=%s message_key=%s: %s",
            req.customer_id, req.message_key, e, exc_info=True,
        )
        raise HTTPException(status_code=500, detail="Failed to encode conversation")


@router.post("/delete-memory-vectors")
async def delete_memory_vectors(req: DeleteMemoryVectorsRequest):
    """
    Hard-delete every vector chunk of a user memory from the vector DB: the
    shared 'memory_{model}' collections (scoped to the customer's rows) plus
    any not-yet-migrated legacy '{customer_id}_memory*' collections.
    """
    if not req.customer_id or not req.memory_key:
        raise HTTPException(status_code=400, detail="customer_id and memory_key are required")

    logger.info("Deleting memory vectors — customer=%s memory_key=%s", req.customer_id, req.memory_key)

    try:
        client = get_milvus_client(req.customer_id)
        memory_filter = f'memory_key == "{_escape_filter_value(req.memory_key)}"'

        deleted_counts: dict[str, int] = {}
        for collection_name, shared in _tenant_scoped_collections(
            client, req.customer_id, "memory", f"{req.customer_id}_memory"
        ):
            scoped = customer_filter(req.customer_id, memory_filter) if shared else memory_filter
            result = client.delete(collection_name=collection_name, filter=scoped)
            delete_count = result.get("delete_count", 0) if hasattr(result, "get") else 0
            deleted_counts[collection_name] = delete_count
            logger.info(
                "Deleted %s vectors for memory_key=%s from collection '%s'",
                delete_count, req.memory_key, collection_name,
            )

        if not deleted_counts:
            logger.info("No memory collections found for customer %s; nothing to delete", req.customer_id)

        return {"status": "success", "deleted": deleted_counts}
    except VectorDBNotConfigured:
        logger.info("No vector DB configured for customer %s; nothing to delete", req.customer_id)
        return {"status": "success", "deleted": {}}
    except Exception as e:
        logger.error("Failed to delete memory vectors for customer=%s memory_key=%s: %s",
                     req.customer_id, req.memory_key, e, exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to delete memory vectors")


@router.post("/delete-instruction-vectors")
async def delete_instruction_vectors(req: DeleteInstructionVectorsRequest):
    """
    Hard-delete every vector chunk of an instruction from the vector DB: the
    shared 'instructions_{model}' collections (scoped to the customer's rows)
    plus any not-yet-migrated legacy '{customer_id}_instructions*' collections.
    """
    if not req.customer_id or not req.instruction_key:
        raise HTTPException(status_code=400, detail="customer_id and instruction_key are required")

    logger.info("Deleting instruction vectors — customer=%s instruction_key=%s",
                req.customer_id, req.instruction_key)

    try:
        client = get_milvus_client(req.customer_id)
        instruction_filter = f'instruction_key == "{_escape_filter_value(req.instruction_key)}"'

        deleted_counts: dict[str, int] = {}
        for collection_name, shared in _tenant_scoped_collections(
            client, req.customer_id, "instructions", f"{req.customer_id}_instructions"
        ):
            scoped = (
                customer_filter(req.customer_id, instruction_filter) if shared else instruction_filter
            )
            result = client.delete(collection_name=collection_name, filter=scoped)
            delete_count = result.get("delete_count", 0) if hasattr(result, "get") else 0
            deleted_counts[collection_name] = delete_count
            logger.info(
                "Deleted %s vectors for instruction_key=%s from collection '%s'",
                delete_count, req.instruction_key, collection_name,
            )

        if not deleted_counts:
            logger.info("No instruction collections found for customer %s; nothing to delete", req.customer_id)

        return {"status": "success", "deleted": deleted_counts}
    except VectorDBNotConfigured:
        logger.info("No vector DB configured for customer %s; nothing to delete", req.customer_id)
        return {"status": "success", "deleted": {}}
    except Exception as e:
        logger.error("Failed to delete instruction vectors for customer=%s instruction_key=%s: %s",
                     req.customer_id, req.instruction_key, e, exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to delete instruction vectors")


@router.post("/delete-conversation-vectors")
async def delete_conversation_vectors(req: DeleteConversationVectorsRequest):
    """
    Hard-delete every vector chunk of one conversation from the vector DB: the
    shared 'conversation_{model}' collections (scoped to the customer's rows)
    plus any not-yet-migrated legacy '{customer_id}_conversation*' collections.
    Raises on failure so the caller retries.
    """
    if not req.customer_id or not req.conversation_key:
        raise HTTPException(status_code=400, detail="customer_id and conversation_key are required")

    logger.info("Deleting conversation vectors — customer=%s conversation_key=%s", req.customer_id, req.conversation_key)

    try:
        client = get_milvus_client(req.customer_id)
        conversation_filter = f'conversation_key == "{_escape_filter_value(req.conversation_key)}"'

        deleted_counts: dict[str, int] = {}
        for collection_name, shared in _tenant_scoped_collections(
            client, req.customer_id, "conversation", f"{req.customer_id}_conversation"
        ):
            scoped = customer_filter(req.customer_id, conversation_filter) if shared else conversation_filter
            result = client.delete(collection_name=collection_name, filter=scoped)
            deleted_counts[collection_name] = result.get("delete_count", 0) if hasattr(result, "get") else 0

        logger.info(
            "Deleted %s vectors of conversation_key=%s from %s collection(s)",
            sum(deleted_counts.values()), req.conversation_key, len(deleted_counts),
        )
        return {"status": "success", "deleted": deleted_counts}
    except VectorDBNotConfigured:
        logger.info("No vector DB configured for customer %s; nothing to delete", req.customer_id)
        return {"status": "success", "deleted": {}}
    except Exception as e:
        logger.error("Failed to delete conversation vectors for customer=%s conversation_key=%s: %s",
                     req.customer_id, req.conversation_key, e, exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to delete conversation vectors")


@router.post("/delete-customer-vectors")
async def delete_customer_vectors(req: DeleteCustomerVectorsRequest):
    """
    Hard-delete every vector a customer owns in their vector DB, for account
    deletion: their rows in each shared '{type}_{model}' collection, and their
    legacy per-customer '{customer_id}_*' collections, which hold nobody else's
    rows and are dropped. Raises on any failure so the caller retries; a
    customer with no vector DB has nothing to delete.
    """
    if not req.customer_id or not CUSTOMER_ID_PATTERN.fullmatch(req.customer_id):
        raise HTTPException(status_code=400, detail="A valid customer_id is required")

    logger.info("Deleting all vectors — customer=%s", req.customer_id)

    try:
        client = get_milvus_client(req.customer_id)
        legacy_prefix = f"{req.customer_id}_"
        deleted: dict[str, int] = {}
        dropped: list[str] = []
        for collection_name in client.list_collections():
            if collection_data_type(collection_name) is not None:
                result = client.delete(collection_name=collection_name, filter=customer_filter(req.customer_id))
                deleted[collection_name] = result.get("delete_count", 0) if hasattr(result, "get") else 0
            elif collection_name.startswith(legacy_prefix):
                client.drop_collection(collection_name=collection_name)
                dropped.append(collection_name)

        logger.info(
            "Deleted %s vectors from %s shared collections and dropped %s legacy collections for customer %s",
            sum(deleted.values()), len(deleted), len(dropped), req.customer_id,
        )
        count("vector_purge_customer_total", status="success")
        return {"status": "success", "deleted": deleted, "dropped": dropped}
    except VectorDBNotConfigured:
        logger.info("No vector DB configured for customer %s; nothing to delete", req.customer_id)
        count("vector_purge_customer_total", status="not_configured")
        return {"status": "success", "deleted": {}, "dropped": []}
    except Exception as e:
        logger.error("Failed to delete all vectors for customer=%s: %s", req.customer_id, e, exc_info=True)
        count("vector_purge_customer_total", status="failure")
        raise HTTPException(status_code=500, detail="Failed to delete customer vectors")
