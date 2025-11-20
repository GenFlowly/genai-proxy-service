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
    
    Expected request body (EmailModel dict):
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
        
        # Validate required fields
        required_fields = ['message_id', 'subject', 'body', 'from', 'to', 'date', 'folder']
        missing_fields = [field for field in required_fields if field not in body]
        
        if missing_fields:
            logger.error(f"Missing required fields: {missing_fields}")
            return {
                'statusCode': 400,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                'body': json.dumps({
                    'error': 'Missing required fields',
                    'missing': missing_fields
                })
            }
        
        # Validate EmailModel can be created
        try:
            email_model = EmailModel.from_dict(body)
            logger.info(f"Validated EmailModel for message_id: {email_model.message_id}")
        except Exception as e:
            logger.error(f"Invalid EmailModel data: {str(e)}")
            return {
                'statusCode': 400,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                'body': json.dumps({
                    'error': 'Invalid email data structure',
                    'details': str(e)
                })
            }
        
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
        
        logger.info(f"Successfully sent message to SQS. MessageId: {response['MessageId']}")
        
        return {
            'statusCode': 202,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({
                'message': 'Email accepted for processing',
                'sqsMessageId': response['MessageId'],
                'emailMessageId': email_model.message_id
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
