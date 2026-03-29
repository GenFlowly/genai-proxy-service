import json
import os
import logging
from typing import Dict, Any, List
from encoding_library.models.memory_request_internal_state import MemoryRequestInternalState

# Trigger build - separated ECR repos

# Trigger rebuild for initial deployment, List
from encoding_library.utils.embedding_utils import create_embeddings

# Set cache directories to /tmp (only writable location in Lambda)
os.environ['TRANSFORMERS_CACHE'] = '/tmp/transformers_cache'
os.environ['HF_HOME'] = '/tmp/huggingface'
os.environ['MPLCONFIGDIR'] = '/tmp/matplotlib'
os.environ['NUMBA_CACHE_DIR'] = '/tmp/numba_cache'
os.environ['JOBLIB_TEMP_FOLDER'] = '/tmp/joblib_tmp'

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Encode Handler - Step 1
    Receives data generates embedding.
    Returns: data + Embedding
    """

    # Parse payload
    payload_dict = event
    
    # Handle API Gateway / Ktor App requests
    if 'body' in event:
        try:
            body = event['body']
            if isinstance(body, str):
                payload_dict = json.loads(body)
            else:
                payload_dict = body
            logger.info("Parsed payload from API Gateway event body")
        except Exception as e:
            logger.error(f"Failed to parse event body: {e}")
            raise ValueError(f"Invalid JSON in event body: {e}")

    # Reconstruct Internal State object
    try:
        memory_request_internal_state = MemoryRequestInternalState.from_dict(payload_dict)
        logger.info("Successfully parsed MemoryRequestInternalState structure")
    except Exception as e:
        logger.error(f"Event does not match MemoryRequestInternalState structure. Parsing failed: {e}")
        raise ValueError("Invalid state payload received in SQS")

    try:
        logger.info(f"Received internal state for customer: {memory_request_internal_state.customer_id}")
        
        # Extract data for encoding
        data = memory_request_internal_state.raw_data
        
        # Inject dataType so that ProcessorFactory can route it correctly
        data['dataType'] = memory_request_internal_state.data_type
        
        # Create embedding using common utility
        # Returns a list of chunks (dicts with vector, text, index)
        embeddings = create_embeddings(data)
        
        # Attach the embeddings precisely back into the formalized node structure
        memory_request_internal_state.data_embeddings = embeddings
        
        # Return the serialized dictionary representation
        return memory_request_internal_state.to_dict()

    except Exception as e:
        logger.error(f"Error in encode handler: {str(e)}", exc_info=True)
        raise
