import json
import os
import logging
from typing import Dict, Any, List
from encoding_library.models.payload import Payload

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
    # If invoked via API Gateway, the actual payload is in the 'body' string
    if 'body' in event:
        try:
            body = event['body']
            # If body is a string (JSON), parse it
            if isinstance(body, str):
                payload_dict = json.loads(body)
            else:
                payload_dict = body
            logger.info("Parsed payload from API Gateway event body")
        except Exception as e:
            logger.error(f"Failed to parse event body: {e}")
            raise ValueError(f"Invalid JSON in event body: {e}")

    # Reconstruct Payload object
    try:
        payload = Payload.from_dict(payload_dict)
        # If we successfully parsed the standard Payload, we still need to process it
        logger.info("Successfully parsed Payload structure")
    except Exception:
        # Fallback for legacy events or if structure doesn't match
        logger.warning("Event does not match Payload structure, attempting legacy handling")
        # Assume event IS the data
        payload = Payload(
            customer_id=event.get('customerId', 'unknown'),
            data=event
        )

    try:
        logger.info(f"Received payload for customer: {payload.customer_id}")
        
        # Extract data for encoding
        data = payload.data
        
        # Create embedding using common utility
        # Returns a list of chunks (dicts with vector, text, index)
        embeddings = create_embeddings(data)
        
        # Add embedding to data
        # We update the data in the payload
        # 'embedding' field now contains the list of chunk dicts
        data['embeddings'] = embeddings # Rename to embeddings (plural) to indicate list
        # For backward compatibility or if processor returns old format (unlikely now)
        # we can check type, but we updated all processors.
        
        payload.data = data
        
        # Return the payload dict
        return payload.to_dict()

    except Exception as e:
        logger.error(f"Error in encode handler: {str(e)}", exc_info=True)
        raise
