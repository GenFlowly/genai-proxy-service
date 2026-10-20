import os
import logging
from typing import Dict, Any, List
from pymilvus import MilvusClient

from encoding_library.processors.processor_factory import ProcessorFactory
from encoding_library.models.memory_request_internal_state import MemoryRequestInternalState
from encoding_library.observability import count, set_request_id, setup_logging, track
from encoding_library.utils.model_registry import build_collection_description, resolve_model
from encoding_library.utils.vector_db import (
    customer_filter,
    ensure_collection,
    escape_filter_value,
    get_milvus_client,
)

from services.content_logging import default_log_level

setup_logging("encoding-server", level=default_log_level())
logger = logging.getLogger()


@track("vector_store")
def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Store Zilliz Handler - Phase 5 Map State Final Node
    Receives a MemoryRequestInternalState dict with an appended 'vectors' list.
    """
    try:
        memory_request_internal_state = MemoryRequestInternalState.from_dict(event)
        set_request_id(memory_request_internal_state.request_id)
        customer_id = memory_request_internal_state.customer_id
        if not customer_id:
            raise ValueError("customer_id is missing from the payload")

        vectors = memory_request_internal_state.vectors
        if not vectors:
            logger.warning("No vectors in iteration payload; skipping.")
            return event

        logger.info(f"Storing {len(vectors)} vectors for customer {customer_id}")

        milvus_client = get_milvus_client(customer_id)
        processor = ProcessorFactory.get_processor(memory_request_internal_state)
        collection_name = processor.get_collection_name(memory_request_internal_state)



        records = processor.prepare_for_vector_db(memory_request_internal_state, vectors)

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

        result = milvus_client.insert(collection_name=collection_name, data=records)
        # No flush: Zilliz serverless auto-seals segments and reads see growing
        # data, so per-insert flush buys nothing — and the cluster allows ~1
        # flush per 20s TOTAL (gRPC RateLimiter, rate=0.05). The Map state runs
        # up to 3 chunk batches concurrently, so any payload over one batch had
        # sibling flushes exhaust pymilvus's retries and fail the execution
        # AFTER its insert succeeded — long messages never embedded.
        milvus_ids = [r["id"] for r in records]

        count("vector_store_chunks_total", result.get("insert_count", 0),
              data_type=memory_request_internal_state.data_type)
        logger.info(f"Inserted {result.get('insert_count', 0)} records into '{collection_name}'.")

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
                        }
                    )
                    logger.info(f"Successfully updated DDB for noteKey {note_key} with {len(milvus_ids)} milvus_ids")
                else:
                    logger.warning("note_key missing in raw_data, skipping DDB update")
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

        # Clear heavy fields after insertion to avoid Step Functions 256KB payload limit
        memory_request_internal_state.vectors = []
        return memory_request_internal_state.to_dict()

    except Exception as e:
        logger.error(f"Error in store_embeddings handler: {str(e)}", exc_info=True)
        raise

