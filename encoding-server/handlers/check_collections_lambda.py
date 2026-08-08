import json
import logging
from typing import Dict, Any

from encoding_library.processors.processor_factory import ProcessorFactory
from encoding_library.models.memory_request_internal_state import MemoryRequestInternalState
from encoding_library.utils.vector_db import get_milvus_client
from services.authorization_service import AuthorizationService

logger = logging.getLogger()
logger.setLevel(logging.INFO)

auth_service = None

def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Lambda to check if Zilliz collections exist for a given customer explicitly.
    """
    try:
        logger.info(f"Received check collections request: {json.dumps(event)}")
        
        global auth_service
        if auth_service is None:
            auth_service = AuthorizationService()
            
        # 1. Authorization Check: Verify user exists in DynamoDB and get customerId
        is_authorized, customer_id, error_response = auth_service.verify_user(event)
        if not is_authorized:
            return error_response
            
        logger.info(f"Authorized customer: {customer_id}. Proceeding to check collections.")
        
        # Connect to Milvus for this customer
        milvus_client = get_milvus_client(customer_id)
        
        body = {}
        if 'body' in event and event['body']:
            if isinstance(event['body'], str):
                try:
                    body = json.loads(event['body'])
                except json.JSONDecodeError:
                    pass
            else:
                body = event['body']
                
        model_name = body.get('model_name', 'all-MiniLM-L6-v2')
        
        existing_collections = []
        missing_collections = []
        
        # 2. Define target types to check
        data_types = ['Email', 'NOTE']
        
        for data_type in data_types:
            dummy_state = MemoryRequestInternalState(
                data_type=data_type,
                customer_id=customer_id,
                client='onboarding',
                raw_data={},
                model_name=model_name
            )
            
            processor = ProcessorFactory.get_processor(dummy_state)
            collection_name = processor.get_collection_name(dummy_state)
            
            if milvus_client.has_collection(collection_name):
                existing_collections.append(collection_name)
            else:
                missing_collections.append(collection_name)
                
        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({
                'message': 'Collection check completed',
                'missing': len(missing_collections) > 0,
                'existing_collections': existing_collections,
                'missing_collections': missing_collections
            })
        }
        
    except Exception as e:
        logger.error(f"Error checking collections: {str(e)}", exc_info=True)
        return {
            'statusCode': 500,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({
                'error': f'Internal server error: {str(e)}'
            })
        }
