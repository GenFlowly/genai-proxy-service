import os
import logging
from typing import Dict, Any, List
from pymilvus import MilvusClient
from factory.processor_factory import ProcessorFactory

# Trigger build - separated ECR repos

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Environment variables
ZILLIZ_ENDPOINT = os.environ.get('ZILLIZ_ENDPOINT')
ZILLIZ_TOKEN = os.environ.get('ZILLIZ_TOKEN')
COLLECTION_NAME = os.environ.get('COLLECTION_NAME', 'test')

if not ZILLIZ_ENDPOINT:
    raise ValueError("ZILLIZ_ENDPOINT environment variable is required")
if not ZILLIZ_TOKEN:
    raise ValueError("ZILLIZ_TOKEN environment variable is required")

def get_milvus_client():
    """Create Milvus client connection."""
    return MilvusClient(
        uri=ZILLIZ_ENDPOINT,
        token=ZILLIZ_TOKEN
    )

def store_in_zilliz(data: Dict[str, Any], embedding: List[float], collection_name: str) -> str:
    """Store data embedding in Zilliz Cloud."""
    try:
        client = get_milvus_client()
        
        # Get appropriate processor
        processor = ProcessorFactory.get_processor(data)
        
        # Prepare data for insertion
        record = processor.prepare_for_vector_db(data, embedding)
        
        # Insert into collection
        result = client.insert(
            collection_name=collection_name,
            data=[record]
        )
        
        logger.info(f"Successfully inserted into Zilliz collection '{collection_name}'. Insert count: {result.get('insert_count', 0)}")
        return record.get('id', 'unknown')
        
    except Exception as e:
        logger.error(f"Error storing in Zilliz: {str(e)}", exc_info=True)
        raise

def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Store Zilliz Handler - Step 2
    Receives: Data + Embedding
    Returns: Data (passed through for next step)
    """
    try:
        # Extract embedding
        embedding = event.get('embedding')
        
        if not embedding:
            raise ValueError("No embedding found in payload")
            
        # Extract customerId for collection name
        customer_id = event.get('customerId')
        if not customer_id:
            raise ValueError("customerId is missing from the event payload")
            
        logger.info(f"Storing embedding for data item in collection {customer_id}")
        store_in_zilliz(event, embedding, customer_id)
        
        # Return event without embedding to save payload size for next step?
        # Or keep it? S3 step doesn't need embedding.
        # Let's remove it to be safe on payload limits, though 768 floats is small (~3KB).
        # But we should return the data for the S3 step.
        
        result = event.copy()
        # Optional: remove embedding if not needed downstream
        del result['embedding']
        
        return result

    except Exception as e:
        logger.error(f"Error in store_zilliz handler: {str(e)}", exc_info=True)
        raise
