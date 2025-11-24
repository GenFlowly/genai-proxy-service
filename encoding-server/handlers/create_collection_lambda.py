import os
import logging
import json
from typing import Dict, Any
from pymilvus import MilvusClient, DataType

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Environment variables
ZILLIZ_ENDPOINT = os.environ.get('ZILLIZ_ENDPOINT')
ZILLIZ_TOKEN = os.environ.get('ZILLIZ_TOKEN')

# Initialize Milvus Client
try:
    client = MilvusClient(
        uri=ZILLIZ_ENDPOINT,
        token=ZILLIZ_TOKEN
    )
except Exception as e:
    logger.error(f"Failed to connect to Zilliz: {str(e)}")
    raise e

def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Creates a Zilliz collection for the customer if it doesn't exist.
    Collection name is the customerId.
    """
    logger.info(f"Received event: {json.dumps(event)}")
    
    try:
        # Extract customerId (collection name)
        # Event comes from Step Functions, so it's the payload from the previous step (Encode)
        # The payload should contain 'customerId' merged by the trigger lambda
        customer_id = event.get('customerId')
        
        if not customer_id:
            raise ValueError("customerId is missing from the event payload")
            
        collection_name = customer_id
        
        # Check if collection exists
        if client.has_collection(collection_name):
            logger.info(f"Collection '{collection_name}' already exists. Skipping creation.")
        else:
            logger.info(f"Collection '{collection_name}' does not exist. Creating...")
            
            # Define Schema
            schema = MilvusClient.create_schema(
                auto_id=False,
                enable_dynamic_field=True,
            )
            
            # Add fields
            schema.add_field(field_name="id", datatype=DataType.VARCHAR, max_length=256, is_primary=True)
            schema.add_field(field_name="vector", datatype=DataType.FLOAT_VECTOR, dim=768)
            schema.add_field(field_name="subject", datatype=DataType.VARCHAR, max_length=512)
            schema.add_field(field_name="from_email", datatype=DataType.VARCHAR, max_length=256)
            schema.add_field(field_name="to_email", datatype=DataType.VARCHAR, max_length=256)
            schema.add_field(field_name="date", datatype=DataType.VARCHAR, max_length=64)
            schema.add_field(field_name="folder", datatype=DataType.VARCHAR, max_length=128)
            schema.add_field(field_name="thread_id", datatype=DataType.VARCHAR, max_length=256)
            schema.add_field(field_name="in_reply_to", datatype=DataType.VARCHAR, max_length=256)
            schema.add_field(field_name="s3_key", datatype=DataType.VARCHAR, max_length=512)
            
            # Create index parameters
            index_params = client.prepare_index_params()
            
            index_params.add_index(
                field_name="vector", 
                index_type="AUTOINDEX",
                metric_type="COSINE"
            )
            
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
