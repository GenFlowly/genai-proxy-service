import json
import os
import boto3
import logging
from typing import Dict, Any, List
from sentence_transformers import SentenceTransformer
from pymilvus import MilvusClient
from email_model import EmailModel

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
encoder = None

def get_encoder():
    """Lazy load the sentence transformer model."""
    global encoder
    if encoder is None:
        logger.info("Loading sentence transformer model...")
        # Using a lightweight model suitable for Lambda (384 dimensions)
        encoder = SentenceTransformer('all-MiniLM-L6-v2')
        logger.info("Model loaded successfully")
    return encoder

def get_milvus_client():
    """Create Milvus client connection."""
    return MilvusClient(
        uri=ZILLIZ_ENDPOINT,
        token=ZILLIZ_TOKEN
    )

def encode_text(text: str) -> List[float]:
    """Encode text to vector embedding."""
    model = get_encoder()
    embedding = model.encode(text, convert_to_numpy=True)
    return embedding.tolist()

def store_in_zilliz(email: EmailModel, embedding: List[float]) -> str:
    """Store email embedding in Zilliz Cloud."""
    try:
        client = get_milvus_client()
        
        # Prepare data for insertion
        data = [{
            "id": email.message_id,
            "vector": embedding,
            "subject": email.subject,
            "from_email": email.from_addr,
            "to_email": ", ".join(email.to_addrs),  # Join list to string
            "date": email.date.isoformat() if email.date else "",
            "folder": email.folder,
            "thread_id": email.thread_id or "",
            "in_reply_to": email.in_reply_to or "",
            "s3_key": f"emails/{email.folder}/{email.message_id}.json"
        }]
        
        # Insert into collection
        result = client.insert(
            collection_name=COLLECTION_NAME,
            data=data
        )
        
        logger.info(f"Successfully inserted into Zilliz. Insert count: {result['insert_count']}")
        return email.message_id
        
    except Exception as e:
        logger.error(f"Error storing in Zilliz: {str(e)}", exc_info=True)
        raise

def store_in_s3(email: EmailModel) -> str:
    """Store raw email data in S3 for backup."""
    try:
        s3_key = f"emails/{email.folder}/{email.message_id}.json"
        
        # Convert EmailModel to dict for storage
        email_dict = email.to_dict()
        
        s3.put_object(
            Bucket=BUCKET_NAME,
            Key=s3_key,
            Body=json.dumps(email_dict, indent=2),
            ContentType='application/json',
            Metadata={
                'messageId': email.message_id,
                'from': email.from_addr,
                'subject': email.subject[:100],  # Limit metadata size
                'folder': email.folder
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
    2. Encodes combined subject + body using sentence transformer
    3. Stores embedding in Zilliz Cloud
    4. Backs up raw email to S3
    """
    processed_count = 0
    failed_count = 0
    
    try:
        logger.info(f"Processing {len(event['Records'])} messages from SQS")
        
        for record in event['Records']:
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
                logger.error(f"Error processing message: {str(e)}", exc_info=True)
                # Continue processing other messages
                continue
        
        logger.info(f"Batch processing complete. Processed: {processed_count}, Failed: {failed_count}")
        
        return {
            'statusCode': 200,
            'body': json.dumps({
                'processed': processed_count,
                'failed': failed_count
            })
        }
        
    except Exception as e:
        logger.error(f"Fatal error in handler: {str(e)}", exc_info=True)
        return {
            'statusCode': 500,
            'body': json.dumps({
                'error': 'Internal server error',
                'processed': processed_count,
                'failed': failed_count
            })
        }
