import json
import os
import logging
from typing import Dict, Any

from flask import Flask, request, jsonify
from pymilvus import MilvusClient

# Ensure models and utils are importable
import sys
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from encoding_library.models.payload import Payload
from encoding_library.utils.embedding_utils import create_embeddings

# Set cache directories to /tmp for consistent environment behavior
os.environ['TRANSFORMERS_CACHE'] = '/tmp/transformers_cache'
os.environ['HF_HOME'] = '/tmp/huggingface'
os.environ['MPLCONFIGDIR'] = '/tmp/matplotlib'
os.environ['NUMBA_CACHE_DIR'] = '/tmp/numba_cache'
os.environ['JOBLIB_TEMP_FOLDER'] = '/tmp/joblib_tmp'

# Initialize Flask app
app = Flask(__name__)

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

ZILLIZ_ENDPOINT = "https://in03-0e3d96c83ea3190.serverless.aws-eu-central-1.cloud.zilliz.com"
ZILLIZ_TOKEN = "27cc6072560645598da1fad99cc23a4f5bb89e916850c099d93a0e8128a5f853d9c586ee85e38147cd5006714234f94cdf247b5d"

def get_milvus_client():
    if not ZILLIZ_ENDPOINT or not ZILLIZ_TOKEN:
        raise ValueError("ZILLIZ_ENDPOINT and ZILLIZ_TOKEN environment variables must be set")
    return MilvusClient(
        uri=ZILLIZ_ENDPOINT,
        token=ZILLIZ_TOKEN
    )

@app.route('/health', methods=['GET'])
def health_check():
    return jsonify({"status": "healthy"}), 200

@app.route('/retrieve', methods=['POST'])
def retrieve():
    """
    Retrieval Endpoint
    1. Creates embeddings of query text
    2. Generates similarities via Zilliz Search
    3. Returns the top N most relevant chunks
    """
    try:
        if not request.is_json:
            return jsonify({"error": "Request must be JSON"}), 400
            
        payload_dict = request.get_json()
        
        try:
            payload = Payload.from_dict(payload_dict)
        except Exception:
            payload = Payload(
                customer_id=payload_dict.get('customer_id', 'unknown'),
                data=payload_dict
            )

        logger.info(f"Received retrieval payload for customer: {payload.customer_id}")
        data = payload.data
        
        query_data = data.get('query_data')
        top_n = data.get('top_n', 3)
        search_params = data.get('search_params', {"metric_type": "COSINE", "params": {"nprobe": 10}})
        similarity_threshold = data.get('similarity_threshold', 0.6)
        
        if not query_data:
            return jsonify({"error": "query_data is required in payload data"}), 400
            
        # 1. create embeddings of text provided
        query_embeddings = create_embeddings(query_data)
        if not query_embeddings:
            return jsonify({"error": "Failed to create embedding for query_data"}), 500
            
        # Use first chunk vector exactly as query
        query_vector = query_embeddings[0].get('vector')
        
        # Determine collection name
        # If 'note_value' is queried, we search the notes collection
        collection_name = payload.customer_id
        if 'note_value' in query_data:
            collection_name = f"{payload.customer_id}_notes"
            
        # Connect to Zilliz
        try:
            client = get_milvus_client()
        except ValueError as e:
            logger.error(f"Configuration error: {e}")
            return jsonify({"error": str(e)}), 500
            
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
                output_fields=["note_value", "title", "subject", "client", "custom_topic", "custom_resolution"]
            )
            
            # Format results and apply similarity threshold filter
            formatted_results = []
            for hits in search_res:
                for hit in hits:
                    distance = hit.get("distance", 0.0)
                    if distance >= similarity_threshold:
                        formatted_results.append({
                            "id": hit.get("id"),
                            "distance": distance,
                            "entity": hit.get("entity", {})
                        })
                    else:
                        logger.info(f"Discarding hit {hit.get('id')} with distance {distance} below threshold {similarity_threshold}")
                    
            data['retrieval_results'] = formatted_results
            logger.info(f"Retrieved {len(formatted_results)} chunks from Zilliz.")
        
        payload.data = data
        return jsonify(payload.to_dict()), 200

    except Exception as e:
        logger.error(f"Error in retrieval handler: {str(e)}", exc_info=True)
        return jsonify({"error": "Internal server error", "message": str(e)}), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5001))
    app.run(host='0.0.0.0', port=port)
