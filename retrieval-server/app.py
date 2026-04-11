import json
import os
import logging
from typing import Dict, Any

from flask import Flask, request, jsonify
from pymilvus import MilvusClient

# Ensure models and utils are importable
import sys
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from encoding_library.models.memory_request_internal_state import MemoryRequestInternalState
from encoding_library.utils.embedding_utils import create_embeddings, get_embedding_model
from encoding_library.utils.vector_db import get_zilliz_credentials

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

def get_milvus_client(customer_id: str):
    zilliz_endpoint, zilliz_token = get_zilliz_credentials(customer_id)
    return MilvusClient(
        uri=zilliz_endpoint,
        token=zilliz_token
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
            internal_state = MemoryRequestInternalState.from_dict(payload_dict)
        except Exception as e:
            logger.error(f"Event parsing into MemoryRequestInternalState failed: {e}")
            return jsonify({"error": f"Invalid state payload: {e}"}), 400

        logger.info(f"Received retrieval request for customer: {internal_state.customer_id}")
        data = internal_state.raw_data
        
        query_data = data.get('query_data')
        top_n = data.get('top_n', 3)
        search_params = data.get('search_params', {"metric_type": "COSINE", "params": {"nprobe": 10}})
        similarity_threshold = data.get('similarity_threshold', 0.6)
        
        if not query_data:
            return jsonify({"error": "query_data is required in payload data"}), 400
            
        # 1. create embeddings of text provided
        encoder = get_embedding_model(internal_state.model_type, internal_state.model_name)
        query_embeddings = create_embeddings([query_data], encoder)
        if not query_embeddings:
            return jsonify({"error": "Failed to create embedding for query_data"}), 500
            
        # Use first chunk vector exactly as query
        query_vector = query_embeddings[0].get('vector')
        
        # Collections to search
        collection_names = [internal_state.customer_id, f"{internal_state.customer_id}_notes"]
        
        # Connect to Zilliz
        try:
            client = get_milvus_client(internal_state.customer_id)
        except Exception as e:
            logger.error(f"Configuration error: {e}")
            return jsonify({"error": str(e)}), 500
            
        all_formatted_results = []
            
        for collection_name in collection_names:
            if not client.has_collection(collection_name):
                logger.warning(f"Collection {collection_name} does not exist, skipping.")
                continue
            
            try:
                # 2 & 3. generate similarities and return top N chunks
                search_res = client.search(
                    collection_name=collection_name,
                    data=[query_vector],
                    limit=top_n,
                    search_params=search_params,
                    output_fields=["note_value", "title", "subject", "client", "custom_topic", "custom_resolution"]
                )
                
                # Format results and apply similarity threshold filter
                for hits in search_res:
                    for hit in hits:
                        distance = hit.get("distance", 0.0)
                        if distance >= similarity_threshold:
                            all_formatted_results.append({
                                "id": hit.get("id"),
                                "distance": distance,
                                "entity": hit.get("entity", {}),
                                "source_collection": collection_name
                            })
                        else:
                            logger.info(f"Discarding hit {hit.get('id')} from {collection_name} with distance {distance} below threshold {similarity_threshold}")
            except Exception as e:
                logger.error(f"Error searching collection {collection_name}: {e}")
                
        # Sort combined results descending by distance and take top N
        all_formatted_results.sort(key=lambda x: x['distance'], reverse=True)
        top_results = all_formatted_results[:top_n]
                    
        data['retrieval_results'] = top_results
        logger.info(f"Retrieved {len(top_results)} top chunks from Zilliz across collections.")
        
        internal_state.raw_data = data
        return jsonify(internal_state.to_dict()), 200

    except Exception as e:
        logger.error(f"Error in retrieval handler: {str(e)}", exc_info=True)
        return jsonify({"error": "Internal server error", "message": str(e)}), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5001))
    app.run(host='0.0.0.0', port=port)
