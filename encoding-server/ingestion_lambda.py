import json
import os
import boto3
import logging
from typing import Dict, Any
from email_model import EmailModel

logger = logging.getLogger()
logger.setLevel(logging.INFO)

sqs = boto3.client('sqs')
QUEUE_URL = os.environ.get('QUEUE_URL')

def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Ingestion Lambda - Receives requests from API Gateway and sends to SQS.
    
    Supports both single email and batch (array) of emails.
    
    Single email format:
    {
        "message_id": "unique-message-id",
        "subject": "Email subject",
        "body": "Email body text",
        "from": "sender@email.com",
        "to": ["recipient@email.com"],
        "date": "2024-01-01T00:00:00Z",
        "folder": "inbox",
        "references": [],
        "in_reply_to": null,
        "thread_id": null
    }
    
    Batch format (array of emails):
    [
        { email1 },
        { email2 },
        ...
    ]
    """
    try:
        logger.info(f"Received event: {json.dumps(event)}")
        
        # Extract body from API Gateway event
        if 'body' in event:
            if isinstance(event['body'], str):
                body = json.loads(event['body'])
            else:
                body = event['body']
        else:
            body = event
        
        # Check if body is an array (batch) or single object
        is_batch = isinstance(body, list)
        emails_to_process = body if is_batch else [body]
        
        logger.info(f"Processing {'batch' if is_batch else 'single'} request with {len(emails_to_process)} email(s)")
        
        # Process each email
        required_fields = ['message_id', 'subject', 'body', 'from', 'to', 'date', 'folder']
        processed_count = 0
        failed_count = 0
        errors = []
        sqs_message_ids = []
        
        for idx, email_data in enumerate(emails_to_process):
            try:
                # Validate required fields
                missing_fields = [field for field in required_fields if field not in email_data]
                
                if missing_fields:
                    error_msg = f"Email {idx}: Missing required fields: {missing_fields}"
                    logger.error(error_msg)
                    errors.append(error_msg)
                    failed_count += 1
                    continue
                
                # Validate EmailModel can be created
                try:
                    email_model = EmailModel.from_dict(email_data)
                    logger.info(f"Email {idx}: Validated EmailModel for message_id: {email_model.message_id}")
                except Exception as e:
                    error_msg = f"Email {idx}: Invalid EmailModel data: {str(e)}"
                    logger.error(error_msg)
                    errors.append(error_msg)
                    failed_count += 1
                    continue
                
                # Convert to dict for SQS (ensures proper serialization)
                email_dict = email_model.to_dict()
                
                # Send to SQS
                response = sqs.send_message(
                    QueueUrl=QUEUE_URL,
                    MessageBody=json.dumps(email_dict),
                    MessageAttributes={
                        'messageId': {
                            'StringValue': email_model.message_id,
                            'DataType': 'String'
                        },
                        'folder': {
                            'StringValue': email_model.folder,
                            'DataType': 'String'
                        }
                    }
                )
                
                sqs_message_ids.append(response['MessageId'])
                processed_count += 1
                logger.info(f"Email {idx}: Successfully sent to SQS. MessageId: {response['MessageId']}")
                
            except Exception as e:
                error_msg = f"Email {idx}: Error processing: {str(e)}"
                logger.error(error_msg, exc_info=True)
                errors.append(error_msg)
                failed_count += 1
        
        # Return appropriate response
        if failed_count > 0 and processed_count == 0:
            # All failed
            return {
                'statusCode': 400,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                'body': json.dumps({
                    'error': 'All emails failed validation',
                    'processed': processed_count,
                    'failed': failed_count,
                    'errors': errors
                })
            }
        
        # At least some succeeded
        return {
            'statusCode': 202,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({
                'message': f'Processed {processed_count} email(s) for ingestion',
                'processed': processed_count,
                'failed': failed_count,
                'sqsMessageIds': sqs_message_ids,
                'errors': errors if errors else None
            })
        }
        
    except json.JSONDecodeError as e:
        logger.error(f"Invalid JSON in request body: {str(e)}")
        return {
            'statusCode': 400,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({
                'error': 'Invalid JSON format'
            })
        }
    
    except Exception as e:
        logger.error(f"Error processing request: {str(e)}", exc_info=True)
        return {
            'statusCode': 500,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({
                'error': 'Internal server error'
            })
        }
