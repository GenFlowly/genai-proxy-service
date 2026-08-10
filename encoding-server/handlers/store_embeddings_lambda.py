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
                    dynamodb.update_item(
                        TableName=table_name,
                        Key={
                            'customerId': {'S': customer_id},
                            'noteKey': {'S': note_key}
                        },
                        UpdateExpression="SET is_synced_with_milvus = :val, milvus_ids = :ids",
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

        # Clear heavy fields after insertion to avoid Step Functions 256KB payload limit
        memory_request_internal_state.vectors = []
        return memory_request_internal_state.to_dict()

    except Exception as e:
        logger.error(f"Error in store_embeddings handler: {str(e)}", exc_info=True)
        raise

