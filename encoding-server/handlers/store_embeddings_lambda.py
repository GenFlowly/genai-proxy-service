import os
import logging
from typing import Dict, Any, List
from pymilvus import MilvusClient

from encoding_library.processors.processor_factory import ProcessorFactory
from encoding_library.models.memory_request_internal_state import MemoryRequestInternalState
from encoding_library.utils.vector_db import get_milvus_client

logger = logging.getLogger()
logger.setLevel(logging.INFO)



def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Store Zilliz Handler - Phase 5 Map State Final Node
    Receives a MemoryRequestInternalState dict with an appended 'vectors' list.
    """
    try:
        memory_request_internal_state = MemoryRequestInternalState.from_dict(event)
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

        if memory_request_internal_state.data_type == "INSTRUCTION":
            # Instruction collections postdate most customers' onboarding
            # /create-collections run, so create on demand. Dim comes from the
            # actual vectors, so it always matches the embedding model used.
            if not milvus_client.has_collection(collection_name):
                from encoding_library.utils.model_registry import resolve_model, build_collection_description
                model_type, model_name = resolve_model(
                    memory_request_internal_state.model_type,
                    memory_request_internal_state.model_name,
                )
                dim = len(records[0]["vector"])
                schema, index_params = processor.get_collection_schema(
                    dim=dim,
                    description=build_collection_description(model_type, model_name, dim),
                )
                milvus_client.create_collection(
                    collection_name=collection_name,
                    schema=schema,
                    index_params=index_params,
                )
                logger.info(f"Created missing collection '{collection_name}' (dim={dim})")

            # Only the latest version is indexed. Chunk ids are {id}_{i}, so a
            # re-encode with fewer chunks would strand stale tail chunks (and
            # Milvus insert does not upsert on duplicate PKs) — drop all prior
            # chunks for this instruction before inserting.
            raw_data = memory_request_internal_state.raw_data or {}
            instruction_key = raw_data.get("instruction_id") or raw_data.get("instructionId")
            if instruction_key:
                try:
                    milvus_client.delete(
                        collection_name=collection_name,
                        filter=f'instruction_key == "{instruction_key}"',
                    )
                except Exception as e:
                    logger.warning(f"Failed to delete prior chunks for instruction {instruction_key}: {str(e)}")

        result = milvus_client.insert(collection_name=collection_name, data=records)
        milvus_client.flush(collection_name=collection_name)
        milvus_ids = [r["id"] for r in records]

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
                logger.error(f"Failed to update DDB for INSTRUCTION: {str(e)}")

        # Clear heavy fields after insertion to avoid Step Functions 256KB payload limit
        memory_request_internal_state.vectors = []
        return memory_request_internal_state.to_dict()

    except Exception as e:
        logger.error(f"Error in store_embeddings handler: {str(e)}", exc_info=True)
        raise

