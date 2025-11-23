import json
import os
import logging
from typing import Dict, Any

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
        # If triggered by SQS directly via Lambda, event might be different.
        # But assuming Step Functions passes the payload directly.
        # If this is the first step in SF, and SF is triggered by SQS, the input might be the SQS message body?
        # Or if we use a "Driver" lambda to read from SQS and start SF, then the input is the email dict.
        
        # Let's assume the input IS the email dictionary (parsed from SQS body).
        # If the input is the raw SQS event, we need to parse it.
        # However, for Step Functions Map state over SQS messages, the input is usually the body.
        
        # Handling both cases: direct payload or SQS record
        payload = event
        if 'Records' in event:
            # This looks like an SQS event. We only process the first one if it's a standard lambda trigger?
            # But for Step Functions, we want a single item.
            # If we use SQS -> Lambda -> SF, the Lambda should pass the single item.
            # If we use Pipe -> SF, the input is the body.
            # Let's assume payload is the email dict.
            pass
            
        # If payload has 'body' (SQS message structure passed through), parse it.
        if 'body' in payload and isinstance(payload['body'], str):
             try:
                 payload = json.loads(payload['body'])
             except:
                 pass

        logger.info(f"Received payload keys: {payload.keys()}")

        email = EmailModel.from_dict(payload)
        logger.info(f"Encoding email: {email.message_id}")

        text_to_encode = f"{email.subject} {email.body}"
        embedding = encode_text(text_to_encode)
        
        # Return the original payload plus the embedding
        # We convert EmailModel back to dict to ensure we have all fields
        result = email.to_dict()
        result['embedding'] = embedding
        
        return result

    except Exception as e:
        logger.error(f"Error in encode handler: {str(e)}", exc_info=True)
        raise
