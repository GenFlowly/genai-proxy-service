import json
import logging
from typing import Dict, Any

from encoding_library.processors.processor_factory import ProcessorFactory
from encoding_library.models.memory_request_internal_state import MemoryRequestInternalState
from encoding_library.utils.vector_db import get_milvus_client
from encoding_library.utils.model_registry import (
    resolve_model,
    get_embedding_dimension,
    build_collection_description,
)
from services.authorization_service import AuthorizationService

logger = logging.getLogger()
logger.setLevel(logging.INFO)

auth_service = None

def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Lambda to create Zilliz collections for a given customer explicitly.
    Called when a customer onboards (e.g. from genai-proxy-server).
    """
    try:
        logger.info(f"Received create collections request: {json.dumps(event)}")
        
        global auth_service
        if auth_service is None:
            auth_service = AuthorizationService()
            
        # 1. Authorization Check: Verify user exists in DynamoDB and get customerId
        is_authorized, customer_id, error_response = auth_service.verify_user(event)
        if not is_authorized:
            return error_response
            
        logger.info(f"Authorized customer: {customer_id}. Proceeding to create collections.")
        
        # Connect to Milvus for this customer
        milvus_client = get_milvus_client(customer_id)
        
        # We need to extract the model_name from the request body if provided, otherwise fallback
        body = {}
        if 'body' in event and event['body']:
            if isinstance(event['body'], str):
                try:
                    body = json.loads(event['body'])
                except json.JSONDecodeError:
                    pass
            else:
                body = event['body']
                
        # Accept both camelCase (MemoryRequest aliases) and snake_case keys
        model_type, model_name = resolve_model(
            body.get('modelType', body.get('model_type')),
            body.get('modelName', body.get('model_name')),
        )

        # Resolve vector dimension: explicit request override -> registry -> probe
        dim = get_embedding_dimension(model_type, model_name, body.get('dimension'))

        # Model metadata stored on the collection so consumers (e.g. retrieval)
        # can discover the embedding model instead of parsing collection names
        description = build_collection_description(model_type, model_name, dim)

        logger.info(f"Creating collections for model_type={model_type} model_name={model_name} dim={dim}")

        created_collections = []
        already_existed = []

        # 2. Define target types to create
        data_types = ['Email', 'NOTE', 'MEMORY', 'CONVERSATION', 'INSTRUCTION']

        for data_type in data_types:
            # Create a dummy state just to resolve the correct processor and schema
            dummy_state = MemoryRequestInternalState(
                data_type=data_type,
                customer_id=customer_id,
                client='onboarding',
                raw_data={},
                model_type=model_type,
                model_name=model_name
            )

            processor = ProcessorFactory.get_processor(dummy_state)
            collection_name = processor.get_collection_name(dummy_state)

            if milvus_client.has_collection(collection_name):
                logger.info(f"Collection '{collection_name}' already exists.")
                already_existed.append(collection_name)
            else:
                logger.info(f"Collection '{collection_name}' does not exist. Creating...")
                schema, index_params = processor.get_collection_schema(dim=dim, description=description)
                milvus_client.create_collection(
                    collection_name=collection_name,
                    schema=schema,
                    index_params=index_params
                )
                logger.info(f"Successfully created '{collection_name}'.")
                created_collections.append(collection_name)

        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({
                'message': 'Collection creation completed',
                'created': created_collections,
                'already_existed': already_existed,
                'model_type': model_type,
                'model_name': model_name,
                'dimension': dim
            })
        }
        
    except Exception as e:
        logger.error(f"Error creating collections: {str(e)}", exc_info=True)
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
