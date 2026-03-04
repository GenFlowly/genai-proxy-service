import os
import logging
import json
from typing import Dict, Any, Tuple
from pymilvus import MilvusClient, DataType
from encoding_library.models.payload import Payload
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

        # ---------------------------------------------------------
        # Create Notes Collection
        # ---------------------------------------------------------
        notes_collection_name = f"{customer_id}_notes"
        
        if client.has_collection(notes_collection_name):
             logger.info(f"Collection '{notes_collection_name}' already exists. Skipping creation.")
        else:
            logger.info(f"Collection '{notes_collection_name}' does not exist. Creating...")
            
            # Define Schema for Notes
            notes_schema = MilvusClient.create_schema(
                auto_id=False,
                enable_dynamic_field=True,
            )
            
            # Add fields for Notes
            notes_schema.add_field(field_name="id", datatype=DataType.VARCHAR, max_length=256, is_primary=True)
            notes_schema.add_field(field_name="vector", datatype=DataType.FLOAT_VECTOR, dim=384) # Using all-MiniLM-L6-v2 which is 384 dim, NOT 768
            notes_schema.add_field(field_name="note_value", datatype=DataType.VARCHAR, max_length=65535)
            notes_schema.add_field(field_name="title", datatype=DataType.VARCHAR, max_length=512)
            notes_schema.add_field(field_name="note_key", datatype=DataType.VARCHAR, max_length=256) # Separate note_key
            notes_schema.add_field(field_name="client", datatype=DataType.VARCHAR, max_length=100)
            notes_schema.add_field(field_name="created_at", datatype=DataType.VARCHAR, max_length=64)
            notes_schema.add_field(field_name="s3_key", datatype=DataType.VARCHAR, max_length=512)
            
            # Create index parameters
            notes_index_params = client.prepare_index_params()
            
            notes_index_params.add_index(
                field_name="vector", 
                index_type="AUTOINDEX",
                metric_type="COSINE"
            )
            
            # Create collection
            client.create_collection(
                collection_name=notes_collection_name,
                schema=notes_schema,
                index_params=notes_index_params
            )
            
            logger.info(f"Successfully created collection '{notes_collection_name}'")
            
        # Pass the event through to the next step
        return event
        
    except Exception as e:
        logger.error(f"Error in create_collection_lambda: {str(e)}", exc_info=True)
        raise e
