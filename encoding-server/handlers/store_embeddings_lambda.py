import os
import logging
from typing import Dict, Any, List
from pymilvus import MilvusClient
from email_model import EmailModel

# Trigger build - separated ECR repos

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Environment variables
ZILLIZ_ENDPOINT = os.environ.get('ZILLIZ_ENDPOINT')
ZILLIZ_TOKEN = os.environ.get('ZILLIZ_TOKEN')
COLLECTION_NAME = os.environ.get('COLLECTION_NAME', 'test')

if not ZILLIZ_ENDPOINT:
    raise ValueError("ZILLIZ_ENDPOINT environment variable is required")
if not ZILLIZ_TOKEN:
    raise ValueError("ZILLIZ_TOKEN environment variable is required")

def get_milvus_client():
    """Create Milvus client connection."""
    return MilvusClient(
        uri=ZILLIZ_ENDPOINT,
        token=ZILLIZ_TOKEN
    )

def store_in_zilliz(email: EmailModel, embedding: List[float]) -> str:
    """Store email embedding in Zilliz Cloud."""
    try:
        client = get_milvus_client()
        
        # Prepare data for insertion
        #
        data = [{
            "id": email.message_id,
            "vector": embedding,
            "subject": email.subject[:500],  # Limit field size
            "from_email": email.from_addr[:200],
            "to_email": ", ".join(email.to_addrs)[:200],  # Join list to string
            "date": email.date.isoformat() if email.date else "",
            "folder": email.folder[:100],
            "thread_id": (email.thread_id or "")[:200],
            "in_reply_to": (email.in_reply_to or "")[:200],
            "s3_key": f"emails/{email.folder}/{email.message_id}.json"
        }]
        
        # Insert into collection
        result = client.insert(
            collection_name=COLLECTION_NAME,
            data=data
        )
        
        logger.info(f"Successfully inserted into Zilliz. Insert count: {result.get('insert_count', 0)}")
        return email.message_id
        
    except Exception as e:
        logger.error(f"Error storing in Zilliz: {str(e)}", exc_info=True)
        raise

def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Store Zilliz Handler - Step 2
    Receives: Email data + Embedding
    Returns: Email data (passed through for next step)
    """
    try:
        # Parse input
        email = EmailModel.from_dict(event)
        embedding = event.get('embedding')
        
        if not embedding:
            raise ValueError("No embedding found in payload")
            
        logger.info(f"Storing embedding for email: {email.message_id}")
        store_in_zilliz(email, embedding)
        
        # Return event without embedding to save payload size for next step?
        # Or keep it? S3 step doesn't need embedding.
        # Let's remove it to be safe on payload limits, though 768 floats is small (~3KB).
        # But we should return the email data for the S3 step.
        
        result = event.copy()
        # Optional: remove embedding if not needed downstream
        # del result['embedding'] 
        
        return result

    except Exception as e:
        logger.error(f"Error in store_zilliz handler: {str(e)}", exc_info=True)
        raise
