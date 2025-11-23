import json
import os
import boto3
import logging
from typing import Dict, Any
from factory.processor_factory import ProcessorFactory

logger = logging.getLogger()
logger.setLevel(logging.INFO)

sqs = boto3.client('sqs')
QUEUE_URL = os.environ.get('QUEUE_URL')

def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    First lambda in encoding server
    Ingestion Lambda - Receives requests from API Gateway and sends to SQS.
    
    Supports both single object and batch (array) of objects.
    Uses ProcessorFactory to handle different data types (e.g. Email).
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
        items_to_process = body if is_batch else [body]
        
        logger.info(f"Processing {'batch' if is_batch else 'single'} request with {len(items_to_process)} item(s)")
        
        # Process each item
        processed_count = 0
        failed_count = 0
        errors = []
        sqs_message_ids = []
        
        for idx, item_data in enumerate(items_to_process):
            try:
                # Get appropriate processor for the data
                processor = ProcessorFactory.get_processor(item_data)
                
                # Validate data
                processor.validate(item_data)
                
                # Convert to SQS message format
                message_body, message_attributes = processor.to_sqs_message(item_data)
                
                # Send to SQS
                response = sqs.send_message(
                    QueueUrl=QUEUE_URL,
                    MessageBody=message_body,
                    MessageAttributes=message_attributes
                )
                
                sqs_message_ids.append(response['MessageId'])
                processed_count += 1
                logger.info(f"Item {idx}: Successfully sent to SQS. MessageId: {response['MessageId']}")
                
            except ValueError as ve:
                error_msg = f"Item {idx}: Validation error: {str(ve)}"
                logger.error(error_msg)
                errors.append(error_msg)
                failed_count += 1
            except Exception as e:
                error_msg = f"Item {idx}: Error processing: {str(e)}"
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
                    'error': 'All items failed validation/processing',
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
                'message': f'Processed {processed_count} item(s) for ingestion',
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
