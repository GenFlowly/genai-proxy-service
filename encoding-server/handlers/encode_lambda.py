import json
import os
import logging
from typing import Dict, Any, List
from models.payload import Payload

# Trigger build - separated ECR repos

# Trigger rebuild for initial deployment, List
from pymilvus import model
from processors.processor_factory import ProcessorFactory
from utils.create_embeddings import encode_text

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
        
        # Get appropriate processor
        processor = ProcessorFactory.get_processor(data)
        
        # Create embedding (processor handles type-specific logic)
        embedding = processor.create_embeddings(data, encode_text)
        
        # Add embedding to data
        # We update the data in the payload
        data['embedding'] = embedding
        payload.data = data
        
        # Return the payload dict
        return payload.to_dict()

    except Exception as e:
        logger.error(f"Error in encode handler: {str(e)}", exc_info=True)
        raise
