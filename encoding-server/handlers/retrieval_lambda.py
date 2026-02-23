import json
import os
import logging
from typing import Dict, Any

from pymilvus import MilvusClient
from models.payload import Payload
from utils.embedding_utils import create_embeddings

# Set cache directories to /tmp (only writable location in Lambda)
os.environ['TRANSFORMERS_CACHE'] = '/tmp/transformers_cache'
os.environ['HF_HOME'] = '/tmp/huggingface'
os.environ['MPLCONFIGDIR'] = '/tmp/matplotlib'
os.environ['NUMBA_CACHE_DIR'] = '/tmp/numba_cache'
os.environ['JOBLIB_TEMP_FOLDER'] = '/tmp/joblib_tmp'

logger = logging.getLogger()
logger.setLevel(logging.INFO)

ZILLIZ_ENDPOINT = os.environ.get('ZILLIZ_ENDPOINT')
ZILLIZ_TOKEN = os.environ.get('ZILLIZ_TOKEN')

def get_milvus_client():
    if not ZILLIZ_ENDPOINT or not ZILLIZ_TOKEN:
        raise ValueError("ZILLIZ_ENDPOINT and ZILLIZ_TOKEN environment variables must be set")
    return MilvusClient(
        uri=ZILLIZ_ENDPOINT,
        token=ZILLIZ_TOKEN
    )

def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Retrieval Handler
    1. Creates embeddings of query text
    2. Generates similarities via Zilliz Search
    3. Returns the top N most relevant chunks
    """
    payload_dict = event
    
    if 'body' in event:
        try:
            body = event['body']
            if isinstance(body, str):
                payload_dict = json.loads(body)
            else:
                payload_dict = body
        except Exception as e:
            logger.error(f"Failed to parse event body: {e}")
            raise ValueError(f"Invalid JSON in event body: {e}")

    try:
        payload = Payload.from_dict(payload_dict)
    except Exception:
        payload = Payload(
            customer_id=event.get('customerId', 'unknown'),
            data=event
        )

    try:
        logger.info(f"Received retrieval payload for customer: {payload.customer_id}")
        data = payload.data
        
        query_data = data.get('query_data')
        top_n = data.get('top_n', 3)
        search_params = data.get('search_params', {"metric_type": "COSINE", "params": {"nprobe": 10}})
        
        if not query_data:
            raise ValueError("query_data is required in payload data")
            
        # 1. create embeddings of text provided
        query_embeddings = create_embeddings(query_data)
        if not query_embeddings:
            raise ValueError("Failed to create embedding for query_data")
            
        # Use first chunk vector exactly as query
        query_vector = query_embeddings[0].get('vector')
        
        # Determine collection name
        # If 'note_value' is queried, we search the notes collection
        collection_name = payload.customer_id
        if 'note_value' in query_data:
            collection_name = f"{payload.customer_id}_notes"
            
        # Connect to Zilliz
        client = get_milvus_client()
        
        # Ensure collection even exists before searching
        if not client.has_collection(collection_name):
            logger.warning(f"Collection {collection_name} does not exist, no results.")
            data['retrieval_results'] = []
        else:
            # 2 & 3. generate similarities and return top N chunks
            # Pass our 1 query vector in a list of lists.
            search_res = client.search(
                collection_name=collection_name,
                data=[query_vector],
                limit=top_n,
                search_params=search_params,
                output_fields=["note_value", "title", "subject", "client", "custom_topic", "custom_resolution"] # Dynamic fields we want back
            )
            
            # Format results
            formatted_results = []
            for hits in search_res:
                for hit in hits:
                    formatted_results.append({
                        "id": hit.get("id"),
                        "distance": hit.get("distance"),
                        "entity": hit.get("entity", {})
                    })
                    
            data['retrieval_results'] = formatted_results
            logger.info(f"Retrieved {len(formatted_results)} chunks from Zilliz.")
        
        payload.data = data
        return payload.to_dict()

    except Exception as e:
        logger.error(f"Error in retrieval handler: {str(e)}", exc_info=True)
        raise
