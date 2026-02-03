import os
import logging
from typing import Dict, Any, List
from pymilvus import MilvusClient
from processors.processor_factory import ProcessorFactory
from models.payload import Payload

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
    Receives: Payload (with Data + Embedding)
    Returns: Payload (passed through for next step)
    """
    try:
        # Reconstruct Payload object
        try:
            payload = Payload.from_dict(event)
        except Exception:
            # Fallback
            payload = Payload(
                customer_id=event.get('customerId') or event.get('customer_id'),
                data=event
            )

        customer_id = payload.customer_id
        if not customer_id:
            raise ValueError("customer_id is missing from the payload")
            
        data = payload.data
        
        # Extract embedding
        embedding = data.get('embedding')
        
        if not embedding:
            raise ValueError("No embedding found in payload data")
            
        logger.info(f"Storing embedding for data item in collection {customer_id}")
        
        # Determine collection name based on data type
        collection_name = customer_id
        if 'note_value' in data:
            collection_name = f"{customer_id}_notes"
            
        store_in_zilliz(data, embedding, collection_name)
        
        # Return payload for next step
        # Optional: remove embedding from data if not needed downstream to save space
        if 'embedding' in data:
            del data['embedding']
            payload.data = data
            
        return payload.to_dict()

    except Exception as e:
        logger.error(f"Error in store_zilliz handler: {str(e)}", exc_info=True)
        raise
