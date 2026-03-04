import os
import logging
from typing import Dict, Any, List
from pymilvus import MilvusClient, DataType
from encoding_library.processors.processor_factory import ProcessorFactory
from encoding_library.models.payload import Payload
from encoding_library.utils.vector_db import get_zilliz_credentials

# Trigger build - separated ECR repos

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Environment variables
COLLECTION_NAME = os.environ.get('COLLECTION_NAME', 'test')

def get_milvus_client(customer_id: str):
    """Create Milvus client connection using credentials fetched dynamically."""
    zilliz_endpoint, zilliz_token = get_zilliz_credentials(customer_id)
    return MilvusClient(
        uri=zilliz_endpoint,
        token=zilliz_token
    )

def ensure_collection_exists(client, collection_name: str, is_notes_collection: bool):
    """Dynamically creates the target collection on Zilliz if it does not already exist."""
    if client.has_collection(collection_name):
        return
        
    logger.info(f"Collection '{collection_name}' does not exist. Creating dynamically...")
    
    schema = MilvusClient.create_schema(
        auto_id=False,
        enable_dynamic_field=True,
    )
    
    if is_notes_collection:
        schema.add_field(field_name="id", datatype=DataType.VARCHAR, max_length=256, is_primary=True)
        schema.add_field(field_name="vector", datatype=DataType.FLOAT_VECTOR, dim=384)
        schema.add_field(field_name="note_value", datatype=DataType.VARCHAR, max_length=65535)
        schema.add_field(field_name="title", datatype=DataType.VARCHAR, max_length=512)
        schema.add_field(field_name="note_key", datatype=DataType.VARCHAR, max_length=256)
        schema.add_field(field_name="client", datatype=DataType.VARCHAR, max_length=100)
        schema.add_field(field_name="created_at", datatype=DataType.VARCHAR, max_length=64)
        schema.add_field(field_name="s3_key", datatype=DataType.VARCHAR, max_length=512)
    else:
        # Default Email Schema
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
        
    index_params = client.prepare_index_params()
    index_params.add_index(
        field_name="vector", 
        index_type="AUTOINDEX",
        metric_type="COSINE"
    )
    
    client.create_collection(
        collection_name=collection_name,
        schema=schema,
        index_params=index_params
    )
    
    logger.info(f"Successfully created dynamic collection '{collection_name}'")

def store_in_zilliz(data: Dict[str, Any], embeddings: List[Dict[str, Any]], collection_name: str, customer_id: str) -> List[str]:
    """Store data embeddings in Zilliz Cloud."""
    try:
        client = get_milvus_client(customer_id)
        
        # Ensure the target collection schema exists
        is_notes = collection_name.endswith('_notes')
        ensure_collection_exists(client, collection_name, is_notes)
        
        # Get appropriate processor
        processor = ProcessorFactory.get_processor(data)
        
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
        
        # Extract embeddings (list of chunks)
        embeddings = data.get('embeddings')
        
        # Backward compatibility / Fallback
        if not embeddings:
            single_embedding = data.get('embedding')
            if single_embedding:
                # Wrap single embedding in list format expected by processor
                # We don't have text/index here easily, but processor might handle empty text if needed
                # Ideally encode_lambda always returns 'embeddings' now.
                embeddings = [{'vector': single_embedding, 'text': '', 'index': 0}]
        
        if not embeddings:
            raise ValueError("No embeddings found in payload data")
            
        logger.info(f"Storing {len(embeddings)} embedding chunks for data item in collection {customer_id}")
        
        # Determine collection name based on data type
        collection_name = customer_id
        if 'note_value' in data:
            collection_name = f"{customer_id}_notes"
            
        store_in_zilliz(data, embeddings, collection_name, customer_id)
        
        # Return payload for next step
        # Optional: remove embedding from data if not needed downstream to save space
        if 'embeddings' in data:
            del data['embeddings']
        if 'embedding' in data:
             del data['embedding']
             
        payload.data = data
            
        return payload.to_dict()

    except Exception as e:
        logger.error(f"Error in store_zilliz handler: {str(e)}", exc_info=True)
        raise
