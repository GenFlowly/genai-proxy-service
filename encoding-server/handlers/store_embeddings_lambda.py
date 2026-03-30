import os
import logging
from typing import Dict, Any, List
from pymilvus import MilvusClient, DataType
from encoding_library.processors.processor_factory import ProcessorFactory
from encoding_library.models.memory_request_internal_state import MemoryRequestInternalState
from encoding_library.utils.vector_db import get_zilliz_credentials

# Trigger build - separated ECR repos

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Environment variables
COLLECTION_NAME = os.environ.get('COLLECTION_NAME', 'test')

def get_milvus_client(customer_id: str):
    """Create Milvus client connection using credentials fetched dynamically."""
    logger.info(f"Starting get_milvus_client for {customer_id}")
    zilliz_endpoint, zilliz_token = get_zilliz_credentials(customer_id)
    
    logger.info(f"Instantiating MilvusClient against endpoint: {zilliz_endpoint}")
    client = MilvusClient(
        uri=zilliz_endpoint,
        token=zilliz_token
    )
    logger.info(f"MilvusClient instantiated successfully")
    return client

def ensure_collection_exists(client, collection_name: str, processor: Any):
    """Dynamically creates the target collection on Zilliz if it does not already exist."""
    if client.has_collection(collection_name):
        return
        
    logger.info(f"Collection '{collection_name}' does not exist. Creating dynamically...")
    
    # Retrieve the schema perfectly mapped to the processor implementation!
    schema, index_params = processor.get_collection_schema()
    
    client.create_collection(
        collection_name=collection_name,
        schema=schema,
        index_params=index_params
    )
    
    logger.info(f"Successfully created dynamic collection '{collection_name}'")

def store_in_zilliz(data: Dict[str, Any], embeddings: List[Dict[str, Any]], customer_id: str) -> List[str]:
    """Store data embeddings in Zilliz Cloud."""
    try:
        client = get_milvus_client(customer_id)
        
        # Get appropriate processor
        processor = ProcessorFactory.get_processor(data)
        
        # Dynamically determine collection name
        collection_name = processor.get_collection_name(customer_id, data)
        
        # Ensure the target collection schema exists
        ensure_collection_exists(client, collection_name, processor)
        
        # Prepare data for insertion (returns list of records)
        records = processor.prepare_for_vector_db(data, embeddings)
        
        # Insert into collection
        # client.insert can handle list of dicts
        result = client.insert(
            collection_name=collection_name,
            data=records
        )
        
        logger.info(f"Successfully inserted into Zilliz collection '{collection_name}'. Insert count: {result.get('insert_count', 0)}")
        return [r.get('id', 'unknown') for r in records]
        
    except Exception as e:
        logger.error(f"Error storing in Zilliz: {str(e)}", exc_info=True)
        raise



def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Store Zilliz Handler - Step 2
    Receives: MemoryRequestInternalState (with Data + Embedding)
    Returns: MemoryRequestInternalState (passed through for next step)
    """
    try:
        # Reconstruct Internal State object
        try:
            internal_state = MemoryRequestInternalState.from_dict(event)
        except Exception as e:
            logger.error(f"Event parsing into MemoryRequestInternalState failed: {e}")
            raise ValueError(f"Invalid state payload: {e}")

        customer_id = internal_state.customer_id
        if not customer_id:
            raise ValueError("customer_id is missing from the payload")
            
        data = internal_state.raw_data
        
        # Inject envelope metadata into raw_data so Processor has access to it during insertion
        data['dataType'] = internal_state.data_type
        data['client'] = internal_state.client
        
        # Extract embeddings directly from the strictly typed envelope!
        embeddings = internal_state.data_embeddings
        
        if not embeddings:
            raise ValueError("No embeddings found in payload data")
            
        logger.info(f"Storing {len(embeddings)} embedding chunks for data item in collection {customer_id}")
        
        store_in_zilliz(data, embeddings, customer_id)
        
        # Return internal state for next step
        # Optional: remove embedding from data if not needed downstream to save space
        internal_state.data_embeddings = None
             
        internal_state.raw_data = data
            
        return internal_state.to_dict()

    except Exception as e:
        logger.error(f"Error in store_zilliz handler: {str(e)}", exc_info=True)
        raise
