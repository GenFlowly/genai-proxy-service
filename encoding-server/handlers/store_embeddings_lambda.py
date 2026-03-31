import os
import logging
from typing import Dict, Any, List
from pymilvus import MilvusClient

from encoding_library.processors.processor_factory import ProcessorFactory
from encoding_library.models.memory_request_internal_state import MemoryRequestInternalState
from encoding_library.utils.vector_db import get_milvus_client

logger = logging.getLogger()
logger.setLevel(logging.INFO)

def ensure_collection_exists(client, collection_name: str, processor: Any):
    """Dynamically securely constructs target collections structurally on Zilliz natively."""
    if client.has_collection(collection_name):
        return
        
    logger.info(f"Collection '{collection_name}' natively absent securely. Generating dynamically...")
    schema, index_params = processor.get_collection_schema()
    client.create_collection(
        collection_name=collection_name,
        schema=schema,
        index_params=index_params
    )



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

        ensure_collection_exists(milvus_client, collection_name, processor)

        records = processor.prepare_for_vector_db(memory_request_internal_state, vectors)
        result = milvus_client.insert(collection_name=collection_name, data=records)
        milvus_client.flush(collection_name=collection_name)

        logger.info(f"Inserted {result.get('insert_count', 0)} records into '{collection_name}'.")

        # Clear heavy fields after insertion to avoid Step Functions 256KB payload limit
        memory_request_internal_state.vectors = []
        return memory_request_internal_state.to_dict()

    except Exception as e:
        logger.error(f"Error in store_embeddings handler: {str(e)}", exc_info=True)
        raise

