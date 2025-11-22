import json
import os
import boto3
import logging
from typing import Dict, Any, List
from pymilvus import MilvusClient, model
from email_model import EmailModel

# Set cache directories to /tmp (only writable location in Lambda)
os.environ['TRANSFORMERS_CACHE'] = '/tmp/transformers_cache'
os.environ['HF_HOME'] = '/tmp/huggingface'
os.environ['MPLCONFIGDIR'] = '/tmp/matplotlib'
os.environ['NUMBA_CACHE_DIR'] = '/tmp/numba_cache'
os.environ['JOBLIB_TEMP_FOLDER'] = '/tmp/joblib_tmp'

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# AWS clients
s3 = boto3.client('s3')

# Environment variables
BUCKET_NAME = os.environ.get('BUCKET_NAME')
ZILLIZ_ENDPOINT = os.environ.get('ZILLIZ_ENDPOINT')
ZILLIZ_TOKEN = os.environ.get('ZILLIZ_TOKEN')
COLLECTION_NAME = os.environ.get('COLLECTION_NAME', 'test')

# Validate required environment variables
if not ZILLIZ_ENDPOINT:
    raise ValueError("ZILLIZ_ENDPOINT environment variable is required")
if not ZILLIZ_TOKEN:
    raise ValueError("ZILLIZ_TOKEN environment variable is required")
if not BUCKET_NAME:
    raise ValueError("BUCKET_NAME environment variable is required")

# Initialize encoder model (loaded once per container)
# Using pymilvus DefaultEmbeddingFunction (768 dimensions, same as notebook)
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
        
        # Use pymilvus DefaultEmbeddingFunction (same as working notebook)
        # This uses sentence-transformers/all-MiniLM-L6-v2 with 384 dimensions
        embedding_fn = model.DefaultEmbeddingFunction()
        logger.info(f"Model loaded successfully. Dimension: {embedding_fn.dim}")
    return embedding_fn

def get_milvus_client():
    """Create Milvus client connection."""
    return MilvusClient(
        uri=ZILLIZ_ENDPOINT,
        token=ZILLIZ_TOKEN
    )

def encode_text(text: str) -> List[float]:
    """Encode text to vector embedding."""
    encoder = get_encoder()
    # DefaultEmbeddingFunction expects a list of documents
    embeddings = encoder.encode_documents([text])
    return embeddings[0].tolist() if hasattr(embeddings[0], 'tolist') else list(embeddings[0])

def store_in_zilliz(email: EmailModel, embedding: List[float]) -> str:
    """Store email embedding in Zilliz Cloud."""
    try:
        client = get_milvus_client()
        
        # Prepare data for insertion
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

def store_in_s3(email: EmailModel) -> str:
    """Store raw email data in S3 for backup."""
    try:
        # Sanitize folder name for S3 key
        folder_safe = email.folder.replace('/', '_').replace('\\', '_')
        s3_key = f"emails/{folder_safe}/{email.message_id}.json"
        
        # Convert EmailModel to dict for storage
        email_dict = email.to_dict()
        
        s3.put_object(
            Bucket=BUCKET_NAME,
            Key=s3_key,
            Body=json.dumps(email_dict, indent=2),
            ContentType='application/json',
            Metadata={
                'messageId': email.message_id[:200],
                'from': email.from_addr[:200],
                'subject': email.subject[:100],  # Limit metadata size
                'folder': folder_safe[:100]
            }
        )
        
        logger.info(f"Successfully stored in S3: {s3_key}")
        return s3_key
        
    except Exception as e:
        logger.error(f"Error storing in S3: {str(e)}", exc_info=True)
        raise

def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Processing Lambda - Receives from SQS, encodes text, stores in Zilliz and S3.
    
    Processes email data from SQS:
    1. Parses EmailModel from SQS message
    2. Encodes combined subject + body using DefaultEmbeddingFunction (768 dims)
    3. Stores embedding in Zilliz Cloud
    4. Backs up raw email to S3
    
    Returns batchItemFailures for SQS partial batch failure handling.
    """
    processed_count = 0
    failed_count = 0
    batch_item_failures = []
    
    try:
        logger.info(f"Processing {len(event['Records'])} messages from SQS")
        
        for record in event['Records']:
            message_id = record.get('messageId')
            try:
                # Parse message body into EmailModel
                email_dict = json.loads(record['body'])
                email = EmailModel.from_dict(email_dict)
                
                logger.info(f"Processing email: {email.message_id} from folder: {email.folder}")
                
                # Combine subject and body for encoding
                text_to_encode = f"{email.subject} {email.body}"
                
                # Generate embedding
                logger.info("Generating embedding...")
                embedding = encode_text(text_to_encode)
                logger.info(f"Generated embedding with dimension: {len(embedding)}")
                
                # Store in Zilliz Cloud
                logger.info("Storing in Zilliz Cloud...")
                store_in_zilliz(email, embedding)
                
                # Backup to S3
                logger.info("Backing up to S3...")
                s3_key = store_in_s3(email)
                
                processed_count += 1
                logger.info(f"Successfully processed email {email.message_id}")
                
            except Exception as e:
                failed_count += 1
                logger.error(f"Error processing message {message_id}: {str(e)}", exc_info=True)
                # Add to batch failures so SQS will retry or send to DLQ
                batch_item_failures.append({"itemIdentifier": message_id})
        
        logger.info(f"Batch processing complete. Processed: {processed_count}, Failed: {failed_count}")
        
        # Return batch item failures for SQS partial batch failure handling
        return {
            'batchItemFailures': batch_item_failures
        }
        
    except Exception as e:
        logger.error(f"Fatal error in handler: {str(e)}", exc_info=True)
        # Return all messages as failures on fatal error
        return {
            'batchItemFailures': [
                {"itemIdentifier": record.get('messageId')} 
                for record in event.get('Records', [])
            ]
        }
