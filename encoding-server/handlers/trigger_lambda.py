import json
import os
import boto3
import logging
from typing import Dict, Any

from encoding_library.observability import set_request_id, setup_logging, track

# Trigger build - separated ECR repos

from services.content_logging import default_log_level
from services.content_source import to_pointer_state

setup_logging("encoding-server", level=default_log_level())
logger = logging.getLogger()

sfn = boto3.client('stepfunctions')
STATE_MACHINE_ARN = os.environ.get('STATE_MACHINE_ARN')

if not STATE_MACHINE_ARN:
    raise ValueError("STATE_MACHINE_ARN environment variable is required")

@track("trigger_ingestion")
def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Trigger Handler
    Receives SQS batch, starts Express Step Function execution for each message.
    Waits for result to report batchItemFailures.
    """
    batch_item_failures = []
    
    try:
        logger.info(f"Processing {len(event['Records'])} messages from SQS")
        
        for record in event['Records']:
            message_id = record.get('messageId')
            try:
                # Parse message body
                body = json.loads(record['body'])
                # Correlate this record's logs with the originating API request
                set_request_id(body.get('request_id'))
                
                # Check if body is already a MemoryRequestInternalState (has customer_id)
                # Note: MemoryRequestInternalState uses 'customer_id', but ingestion may use 'customerId'
                
                customer_id = body.get('customer_id') or body.get('customerId')
                
                if not customer_id:
                    # Fallback: Extract customerId from message attributes
                    message_attributes = record.get('messageAttributes', {})
                    # SQS attributes can be 'StringValue' or 'stringValue' depending on the source/proxy
                    customer_id_attr = message_attributes.get('customerId', {})
                    customer_id = customer_id_attr.get('stringValue') or customer_id_attr.get('StringValue')
                    
                    if customer_id:
                        body['customer_id'] = customer_id
                        logger.info(f"Added customer_id {customer_id} to state payload for message {message_id}")
                else:
                    logger.info(f"Found customer_id {customer_id} in state payload for message {message_id}")

                # Execution input and history must never hold text, including
                # for messages queued before ingestion stopped sending it.
                body = to_pointer_state(body)

                # Start Asynchronous Execution (Standard Workflow)
                logger.info(f"Starting execution for message {message_id}")
                response = sfn.start_execution(
                    stateMachineArn=STATE_MACHINE_ARN,
                    name=f"{message_id}-{context.aws_request_id}", # Unique name
                    input=json.dumps(body)
                )
                
                # Check status
                # Standard execution immediately returns executionArn
                logger.info(f"Execution {response.get('executionArn')} dispatched for {message_id}")
                    
            except Exception as e:
                logger.error(f"Error processing message {message_id}: {str(e)}", exc_info=True)
                batch_item_failures.append({"itemIdentifier": message_id})
        
        return {
            'batchItemFailures': batch_item_failures
        }
        
    except Exception as e:
        logger.error(f"Fatal error in trigger handler: {str(e)}", exc_info=True)
        # Fail all
        return {
            'batchItemFailures': [
                {"itemIdentifier": record.get('messageId')} 
                for record in event.get('Records', [])
            ]
        }
