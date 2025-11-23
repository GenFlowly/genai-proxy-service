import json
import os
import boto3
import logging
from typing import Dict, Any

logger = logging.getLogger()
logger.setLevel(logging.INFO)

sfn = boto3.client('stepfunctions')
STATE_MACHINE_ARN = os.environ.get('STATE_MACHINE_ARN')

if not STATE_MACHINE_ARN:
    raise ValueError("STATE_MACHINE_ARN environment variable is required")

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
                
                # Start Synchronous Execution
                logger.info(f"Starting execution for message {message_id}")
                response = sfn.start_sync_execution(
                    stateMachineArn=STATE_MACHINE_ARN,
                    name=f"{message_id}-{context.aws_request_id}", # Unique name
                    input=json.dumps(body)
                )
                
                # Check status
                #
                if response['status'] != 'SUCCEEDED':
                    logger.error(f"Execution failed for {message_id}: {response.get('error')} - {response.get('cause')}")
                    batch_item_failures.append({"itemIdentifier": message_id})
                else:
                    logger.info(f"Execution succeeded for {message_id}")
                    
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
