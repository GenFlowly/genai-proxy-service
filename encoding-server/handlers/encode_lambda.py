import json
import os
import logging
from typing import Dict, Any, List
from models.payload import Payload

# Trigger build - separated ECR repos

# Trigger rebuild for initial deployment, List
from pymilvus import model
from email_model import EmailModel

# Set cache directories to /tmp (only writable location in Lambda)
os.environ['TRANSFORMERS_CACHE'] = '/tmp/transformers_cache'
os.environ['HF_HOME'] = '/tmp/huggingface'
os.environ['MPLCONFIGDIR'] = '/tmp/matplotlib'
os.environ['NUMBA_CACHE_DIR'] = '/tmp/numba_cache'
os.environ['JOBLIB_TEMP_FOLDER'] = '/tmp/joblib_tmp'

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Initialize encoder model (loaded once per container)
#
embedding_fn = None

def get_encoder():
    """Lazy load the embedding function."""
    global embedding_fn
    if embedding_fn is None:
        logger.info("Loading embedding model...")
        logger.info(f"Cache directory: {os.environ.get('TRANSFORMERS_CACHE')}")
        
        # Create cache directories if they don't exist
        os.makedirs('/tmp/transformers_cache', exist_ok=True)
        os.makedirs('/tmp/huggingface', exist_ok=True)
        
        # Use pymilvus DefaultEmbeddingFunction
        embedding_fn = model.DefaultEmbeddingFunction()
        logger.info(f"Model loaded successfully. Dimension: {embedding_fn.dim}")
    return embedding_fn

def encode_text(text: str) -> List[float]:
    """Encode text to vector embedding."""
    encoder = get_encoder()
    # DefaultEmbeddingFunction expects a list of documents
    embeddings = encoder.encode_documents([text])
    return embeddings[0].tolist() if hasattr(embeddings[0], 'tolist') else list(embeddings[0])

def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Encode Handler - Step 1
    Receives email data (from SQS via Lambda/Step Function), generates embedding.
    Returns: Email data + Embedding
    """



    try:
        # Parse payload
        # Event should be the Payload dict from Step Functions
        payload_dict = event
        
        # Handle SQS wrapping if present (though Trigger Lambda should have unwrapped it)
        if 'Records' in event:
             # This shouldn't happen with current Step Functions flow, but just in case
             pass
             
        # Reconstruct Payload object
        try:
            payload = Payload.from_dict(payload_dict)
        except Exception:
            # Fallback for legacy events or if structure doesn't match
            logger.warning("Event does not match Payload structure, attempting legacy handling")
            # Assume event IS the data
            payload = Payload(
                customer_id=event.get('customerId', 'unknown'),
                data=event
            )

        logger.info(f"Received payload for customer: {payload.customer_id}")
        
        # Extract data for encoding
        data = payload.data
        
        # Create EmailModel to get text
        email = EmailModel.from_dict(data)
        logger.info(f"Encoding email: {email.message_id}")

        text_to_encode = f"{email.subject} {email.body}"
        embedding = encode_text(text_to_encode)
        
        # Add embedding to data
        # We update the data in the payload
        data['embedding'] = embedding
        payload.data = data
        
        # Return the payload dict
        return payload.to_dict()

    except Exception as e:
        logger.error(f"Error in encode handler: {str(e)}", exc_info=True)
        raise
