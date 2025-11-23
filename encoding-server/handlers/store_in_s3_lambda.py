import json
import os
import boto3
import logging
from typing import Dict, Any
from email_model import EmailModel

# Trigger build - separated ECR repos

logger = logging.getLogger()
logger.setLevel(logging.INFO)

s3 = boto3.client('s3')
BUCKET_NAME = os.environ.get('BUCKET_NAME')

if not BUCKET_NAME:
    raise ValueError("BUCKET_NAME environment variable is required")

def store_in_s3(email: EmailModel) -> str:
    """Store raw email data in S3 for backup."""
    try:
        # Sanitize folder name for S3 key
        #
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
    Store S3 Handler - Step 3
    Receives: Email data
    Returns: Success status
    """
    try:
        email = EmailModel.from_dict(event)
        logger.info(f"Backing up email to S3: {email.message_id}")
        
        s3_key = store_in_s3(email)
        
        return {
            "status": "success",
            "messageId": email.message_id,
            "s3Key": s3_key
        }

    except Exception as e:
        logger.error(f"Error in store_s3 handler: {str(e)}", exc_info=True)
        raise
