import os
import logging
import json
from typing import Dict, Any, Tuple
from pymilvus import MilvusClient
from encoding_library.models.payload import Payload
from encoding_library.processors.processor_factory import ProcessorFactory
from encoding_library.utils.vector_db import get_zilliz_credentials

logger = logging.getLogger()
logger.setLevel(logging.INFO)



def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Creates a Zilliz collection for the customer if it doesn't exist.
    Collection name is the customerId.
    """
    logger.info(f"Received event: {json.dumps(event)}")
    
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
            
        # Initialize Milvus Client specifically for this customer
        zilliz_endpoint, zilliz_token = get_zilliz_credentials(customer_id)
        client = MilvusClient(
            uri=zilliz_endpoint,
            token=zilliz_token
        )
            
        # Get processor based on payload matching
        processor = ProcessorFactory.get_processor(payload.data)
        
        collection_name = processor.get_collection_name(customer_id, payload.data)
        
        # Check if collection exists
        if client.has_collection(collection_name):
            logger.info(f"Collection '{collection_name}' already exists. Skipping creation.")
        else:
            logger.info(f"Collection '{collection_name}' does not exist. Creating...")
            
            # Fetch Schema dynamically
            schema, index_params = processor.get_collection_schema()
            
            # Create collection
            client.create_collection(
                collection_name=collection_name,
                schema=schema,
                index_params=index_params
            )
            
            logger.info(f"Successfully created collection '{collection_name}'")

        # Pass the event through to the next step
        return event
        
    except Exception as e:
        logger.error(f"Error in create_collection_lambda: {str(e)}", exc_info=True)
        raise e
