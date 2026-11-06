import os
import logging
from typing import Dict, Any, List, Optional

from botocore.exceptions import ClientError
from encoding_library.chunkers.enums import ChunkingType
from encoding_library.models.memory_request_internal_state import MemoryRequestInternalState
from encoding_library.observability import count, set_request_id, setup_logging, track
from encoding_library.processors.processor_factory import ProcessorFactory
from encoding_library.utils.embedding_utils import (
    create_chunks,
    create_embeddings,
    get_embedding_model_for_customer,
)
from encoding_library.utils.model_registry import build_collection_description, get_chunking_params, resolve_model
from encoding_library.utils.vector_db import (
    customer_filter,
    ensure_collection,
    escape_filter_value,
    get_milvus_client,
)

from handlers.vector_sync_pending import clear_pending
from services.content_logging import default_log_level
from services.content_source import content_sha256, load_raw_data

setup_logging("encoding-server", level=default_log_level())
logger = logging.getLogger()


def _reload_batch_chunks(
    state: MemoryRequestInternalState,
    chunk_offset: int,
    chunk_count: Optional[int],
    chunk_total: Optional[int],
    expected_digest: str,
) -> List[str]:
    """This batch's chunks, re-derived from the item's source table. Empty
    when the item is gone, or changed after parse-and-chunk planned the
    batches: the save that changed it queued its own run."""
    raw_data = load_raw_data(state)
    if raw_data is None:
        return []
    state.raw_data = raw_data
    text = ProcessorFactory.get_processor(state).get_text_to_encode(state)
    if content_sha256(text) != expected_digest:
        count("pipeline_content_changed_total", data_type=state.data_type)
        logger.info(f"Item changed after chunking; skipping the batch at offset {chunk_offset}")
        return []

    chunking_type = state.chunking_type or ChunkingType.RECURSIVE.value
    encoder = None
    if chunking_type == ChunkingType.SEMANTIC.value:
        encoder = get_embedding_model_for_customer(state.customer_id, state.model_type, state.model_name)
    chunk_size, chunk_overlap = get_chunking_params(
        state.model_type, state.model_name, state.chunk_size, state.chunk_overlap
    )
    chunks = create_chunks(
        text,
        encoder,
        chunking_type=chunking_type,
        chunking_technique=state.chunking_technique,
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
    )
    if chunk_total is not None and len(chunks) != int(chunk_total):
        # Re-chunking disagreed with the plan (semantic chunking is not
        # deterministic): the first batch embeds every chunk so vector ids
        # stay contiguous, and the other batches stand down.
        logger.warning(
            f"Chunk plan mismatch ({chunk_total} planned, {len(chunks)} now); the first batch embeds all"
        )
        return chunks if chunk_offset == 0 else []
    end = chunk_offset + int(chunk_count) if chunk_count is not None else len(chunks)
    return chunks[chunk_offset:end]


def _summary(state: MemoryRequestInternalState, collection: str, inserted: int) -> Dict[str, Any]:
    """Tiny per-batch result. The Map state discards iteration output, but a
    multi-batch payload still aggregates every iteration's return into one
    array at the Map join — returning the full state there re-creates the
    256KB problem this handler exists to kill."""
    return {
        "request_id": state.request_id,
        "data_type": state.data_type,
        "collection": collection,
        "inserted": inserted,
    }


@track("create_and_store")
def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Embed one Map-state batch and store it in the vector DB — a single step.

    Merges the former create-embeddings and store-embeddings lambdas. Step
    Functions caps state-to-state payloads at 256KB, and a batch of ~10+
    vectors returned inline exceeded it (States.DataLimitExceeded), so
    messages over roughly 24K characters could never embed. Keeping the
    vectors inside one invocation removes that ceiling entirely.

    Redrive-safe: a failed execution may still have stored SIBLING batches of
    the same payload before the failure, so this step deletes its own chunk
    ids before inserting — replaying the original message from the DLQ (or any
    resend) converges to exactly one row per id instead of duplicating
    (Milvus insert does not upsert on duplicate primary keys).
    """
    try:
        # Global index of this batch's first chunk, stamped by parse-and-chunk
        # outside the typed state; popped before from_dict sees it. Batches of
        # source-backed types carry their chunk plan instead of the chunks.
        chunk_offset = int(event.pop("chunk_offset", 0) or 0)
        chunk_count = event.pop("chunk_count", None)
        chunk_total = event.pop("chunk_total", None)
        expected_digest = event.pop("content_sha256", None)
        memory_request_internal_state = MemoryRequestInternalState.from_dict(event)
        set_request_id(memory_request_internal_state.request_id)
        customer_id = memory_request_internal_state.customer_id
        if not customer_id:
            raise ValueError("customer_id is missing from the payload")

        if not memory_request_internal_state.data_chunks and expected_digest:
            reloaded = _reload_batch_chunks(
                memory_request_internal_state, chunk_offset, chunk_count, chunk_total, expected_digest
            )
            if not reloaded:
                return _summary(memory_request_internal_state, collection="", inserted=0)
            memory_request_internal_state.data_chunks = reloaded

        chunks = memory_request_internal_state.data_chunks
        if not chunks:
            logger.warning("No data_chunks found in batch payload. Skipping.")
            return _summary(memory_request_internal_state, collection="", inserted=0)

        encoder = get_embedding_model_for_customer(
            customer_id,
            memory_request_internal_state.model_type,
            memory_request_internal_state.model_name,
        )
        logger.info(f"Generating vectors for {len(chunks)} chunks...")
        vectors = create_embeddings(chunks, encoder, customer_id=customer_id)
        count("embedding_chunks_total", len(vectors))

        logger.info(f"Storing {len(vectors)} vectors for customer {customer_id}")
        milvus_client = get_milvus_client(customer_id)
        processor = ProcessorFactory.get_processor(memory_request_internal_state)
        collection_name = processor.get_collection_name(memory_request_internal_state)

        records = processor.prepare_for_vector_db(memory_request_internal_state, vectors)

        if chunk_offset and memory_request_internal_state.data_type != "EMAIL":
            # Processors number chunk ids within the batch, so sibling batches
            # of one payload would collide on _0.._N. Shift by the global
            # offset. EMAIL is excluded: its ids are "{customer}:{message_id}"
            # with no positional suffix. The endswith guard is a backstop for
            # any id shape that doesn't carry the enumerate index.
            for j, record in enumerate(records):
                if record["id"].endswith(f"_{j}"):
                    record["id"] = f"{record['id'][: -len(str(j))]}{chunk_offset + j}"

        # Shared collections are created on first write (the onboarding
        # /create-collections lambda also warms them). Dim comes from the
        # actual vectors, so it always matches the embedding model used.
        model_type, model_name = resolve_model(
            memory_request_internal_state.model_type,
            memory_request_internal_state.model_name,
        )
        dim = len(records[0]["vector"])
        schema, index_params = processor.get_collection_schema(
            dim=dim,
            description=build_collection_description(model_type, model_name, dim),
        )
        if ensure_collection(milvus_client, collection_name, schema, index_params):
            logger.info(f"Created missing collection '{collection_name}' (dim={dim})")

        if memory_request_internal_state.data_type == "INSTRUCTION":
            # Only the latest version is indexed. Chunk ids are {id}_{i}, so a
            # re-encode with fewer chunks would strand stale tail chunks (and
            # Milvus insert does not upsert on duplicate PKs) — drop all prior
            # chunks for this instruction before inserting. Scoped to the
            # customer's rows: the collection is shared across tenants.
            raw_data = memory_request_internal_state.raw_data or {}
            instruction_key = raw_data.get("instruction_id") or raw_data.get("instructionId")
            if instruction_key:
                try:
                    milvus_client.delete(
                        collection_name=collection_name,
                        filter=customer_filter(
                            customer_id,
                            f'instruction_key == "{escape_filter_value(instruction_key)}"',
                        ),
                    )
                except Exception as e:
                    logger.warning(f"Failed to delete prior chunks for instruction {instruction_key}: {str(e)}")

        # Replace, don't append: delete this batch's ids first so a DLQ
        # redrive or sweep resend overwrites rows instead of duplicating them.
        # Deleting ids that don't exist is a no-op, so the common path pays
        # one cheap extra call.
        ids_expr = ", ".join(f'"{escape_filter_value(r["id"])}"' for r in records)
        milvus_client.delete(
            collection_name=collection_name,
            filter=customer_filter(customer_id, f"id in [{ids_expr}]"),
        )

        result = milvus_client.insert(collection_name=collection_name, data=records)
        # No flush: Zilliz serverless auto-seals segments and reads see growing
        # data; per-insert flush fought the cluster-wide ~1-per-20s flush quota
        # and failed executions whose inserts had already succeeded (#216).
        milvus_ids = [r["id"] for r in records]

        count("vector_store_chunks_total", result.get("insert_count", 0),
              data_type=memory_request_internal_state.data_type)
        logger.info(f"Inserted {result.get('insert_count', 0)} records into '{collection_name}'.")
        clear_pending(customer_id, memory_request_internal_state.data_type, memory_request_internal_state.raw_data)

        if memory_request_internal_state.data_type == "NOTE":
            try:
                import boto3
                dynamodb = boto3.client('dynamodb', region_name=os.getenv('AWS_REGION', 'us-east-1'))
                raw_data = memory_request_internal_state.raw_data or {}
                note_key = raw_data.get("note_key") or raw_data.get("noteKey") or raw_data.get("note_id")

                if note_key:
                    table_name = os.getenv('CUSTOMER_NOTES_TABLE', 'CustomerNotes')
                    # Mark synced AND drop the note out of the batch work queue by
                    # removing embedding_status (sparse-GSI key). REMOVE of an
                    # absent attribute is a no-op, so this is safe for the realtime
                    # path too (those notes never carry embedding_status).
                    dynamodb.update_item(
                        TableName=table_name,
                        Key={
                            'customerId': {'S': customer_id},
                            'noteKey': {'S': note_key}
                        },
                        UpdateExpression=(
                            "SET is_synced_with_milvus = :val, milvus_ids = :ids "
                            "REMOVE embedding_status, embedding_batch_id"
                        ),
                        ExpressionAttributeValues={
                            ':val': {'BOOL': True},
                            ':ids': {'L': [{'S': str(mid)} for mid in milvus_ids]}
                        },
                        # A note deleted meanwhile must stay deleted: an update
                        # on a missing item would create a bare row.
                        ConditionExpression="attribute_exists(noteKey)",
                    )
                    logger.info(f"Successfully updated DDB for noteKey {note_key} with {len(milvus_ids)} milvus_ids")
                else:
                    logger.warning("note_key missing in raw_data, skipping DDB update")
            except ClientError as e:
                if e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                    # Its deletion job removes the vectors just stored.
                    count("vector_store_note_deleted_total")
                    logger.info(f"Note {note_key} was deleted while it was being stored; not marking it synced")
                else:
                    count("vector_store_ddb_writeback_failure_total", data_type="NOTE")
                    logger.error(f"Failed to update DDB for NOTE: {str(e)}")
            except Exception as e:
                # Swallowed by design (the vectors ARE stored), but counted:
                # the note is never marked synced, so unalarmed failures here
                # cause silent re-processing drift.
                count("vector_store_ddb_writeback_failure_total", data_type="NOTE")
                logger.error(f"Failed to update DDB for NOTE: {str(e)}")

        if memory_request_internal_state.data_type == "INSTRUCTION":
            try:
                import boto3
                dynamodb = boto3.client('dynamodb', region_name=os.getenv('AWS_REGION', 'us-east-1'))
                raw_data = memory_request_internal_state.raw_data or {}
                instruction_id = raw_data.get("instruction_id") or raw_data.get("instructionId")
                version = raw_data.get("version")

                if instruction_id and version is not None:
                    table_name = os.getenv('INSTRUCTIONS_TABLE', 'Instructions')
                    # Embedding-sync bookkeeping on the exact (id, version) row
                    # that was indexed — same shape as the NOTE writeback above.
                    # Instruction rows are content-immutable; these attributes
                    # are sync metadata and are never read by the content caches.
                    dynamodb.update_item(
                        TableName=table_name,
                        Key={
                            'instructionId': {'S': instruction_id},
                            'version': {'N': str(int(version))}
                        },
                        UpdateExpression="SET is_synced_with_milvus = :val, milvus_ids = :ids",
                        ExpressionAttributeValues={
                            ':val': {'BOOL': True},
                            ':ids': {'L': [{'S': str(mid)} for mid in milvus_ids]}
                        }
                    )
                    logger.info(f"Updated DDB for instruction {instruction_id} v{version} with {len(milvus_ids)} milvus_ids")
                else:
                    logger.warning("instruction_id/version missing in raw_data, skipping DDB update")
            except Exception as e:
                count("vector_store_ddb_writeback_failure_total", data_type="INSTRUCTION")
                logger.error(f"Failed to update DDB for INSTRUCTION: {str(e)}")

        return _summary(
            memory_request_internal_state,
            collection=collection_name,
            inserted=result.get("insert_count", 0),
        )

    except Exception as e:
        logger.error(f"Error in create_and_store handler: {str(e)}", exc_info=True)
        raise
