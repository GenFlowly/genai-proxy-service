import json
import os
import boto3
import logging
from typing import Dict, Any
from encoding_library.processors.processor_factory import ProcessorFactory
from services.authorization_service import AuthorizationService
from encoding_library.models.memory_request_internal_state import MemoryRequestInternalState
from encoding_library.observability import request_id_from_lambda_event, set_request_id, setup_logging, track

# Trigger build - separated ECR repos

setup_logging("encoding-server")
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# We initialize these inside the handler to prevent INIT phase credential timeouts 
# if the environment is missing AWS_REGION.
sqs = None
QUEUE_URL = os.environ.get('QUEUE_URL')

auth_service = None

# LAMBDA 1
@track("ingest_email")
def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    First lambda in encoding server
    Ingestion Lambda -
    1. Authorizes request
    1. Receives List of MemoryRequest from API Gateway
    2. Validates the request
    3. Wraps it in Internal Memory Request
    4. Sends to SQS.
    
    Supports both single object and batch (array) of objects.
    Uses ProcessorFactory to handle different data types (e.g. Email).
    """
    try:
        # Adopt the caller's X-Request-Id (or mint one) and carry it through
        # SQS/Step Functions via the state payload for end-to-end correlation
        request_id = set_request_id(request_id_from_lambda_event(event))
        logger.info(f"Received event: {json.dumps(event)}")
        
        # Initialize AWS clients inside the handler so they don't block the INIT phase
        global sqs, auth_service
        if sqs is None:
            region = os.environ.get('AWS_REGION', 'us-east-1')
            sqs = boto3.client('sqs', region_name=region)
        if auth_service is None:
            # AuthorizationService also initializes DynamoDB, so it must be delayed as well
            auth_service = AuthorizationService()
            
        # 1. Authorization Check: Verify user exists in DynamoDB and get customerId
        is_authorized, customer_id, error_response = auth_service.verify_user(event)
        if not is_authorized:
            return error_response
        
        # 2. Process Data
        
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
        entries = [] # For SQS batch sending
        
        for idx, item_data in enumerate(items_to_process):
            try:
                if not all(k in item_data for k in ('client', 'data')):
                    raise ValueError(f"Payload must contain 'client' and 'data'. Got keys: {list(item_data.keys())}")

                # Build typed internal state directly from the envelope — no flattening
                # Accept both camelCase (MemoryRequest aliases) and snake_case keys
                internal_state = MemoryRequestInternalState(
                    data_type='Email',
                    customer_id=customer_id,
                    client=item_data['client'],
                    raw_data=item_data['data'],
                    model_type=item_data.get('modelType', item_data.get('model_type')),
                    model_name=item_data.get('modelName', item_data.get('model_name')),
                    chunking_type=item_data.get('chunkingType', item_data.get('chunking_type')),
                    chunking_technique=item_data.get('chunkingTechnique', item_data.get('chunking_technique')),
                    chunk_size=item_data.get('chunkSize', item_data.get('chunk_size')),
                    chunk_overlap=item_data.get('chunkOverlap', item_data.get('chunk_overlap')),
                    request_id=request_id,
                )

                # Get appropriate processor from the typed state
                processor = ProcessorFactory.get_processor(internal_state)

                # Validate via typed state
                processor.validate(internal_state)

                # Convert to SQS message format
                message_body, message_attributes = processor.to_sqs_message(internal_state)

                # Send to SQS
                response = sqs.send_message(
                    QueueUrl=QUEUE_URL,
                    MessageBody=message_body,
                    MessageAttributes=message_attributes
                )

                sqs_message_ids.append(response['MessageId'])
                processed_count += 1
                
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
