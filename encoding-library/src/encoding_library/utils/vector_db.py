import os
import logging
import base64
import boto3
from typing import Tuple

logger = logging.getLogger(__name__)

region_name = os.environ.get('AWS_REGION', 'us-east-1')
dynamodb = boto3.resource('dynamodb', region_name=region_name)
kms_client = boto3.client('kms', region_name=region_name)

VECTOR_DB_TABLE_NAME = os.environ.get('CUSTOMER_VECTOR_DB_CONFIG_TABLE', 'CustomerVectorDBConfig')
vector_db_table = dynamodb.Table(VECTOR_DB_TABLE_NAME)

GLOBAL_ZILLIZ_ENDPOINT = os.environ.get('ZILLIZ_ENDPOINT')
GLOBAL_ZILLIZ_TOKEN = os.environ.get('ZILLIZ_TOKEN')

def get_zilliz_credentials(customer_id: str) -> Tuple[str, str]:
    """
    Fetches Zilliz endpoint and token from DynamoDB, decrypting them with KMS.
    Falls back to environment variables if DynamoDB record is missing or fetching fails.
    """
    logger.info(f"Fetching Zilliz credentials from DynamoDB for {customer_id}")
    try:
        logger.info(f"Calling DynamoDB get_item for {customer_id}")
        response = vector_db_table.get_item(
            Key={'customerId': customer_id}
        )
        logger.info(f"DynamoDB response received for {customer_id}")
        item = response.get('Item')
        if not item:
            if GLOBAL_ZILLIZ_ENDPOINT and GLOBAL_ZILLIZ_TOKEN:
                logger.info(f"No vector DB config for {customer_id}, using environment fallback")
                return GLOBAL_ZILLIZ_ENDPOINT, GLOBAL_ZILLIZ_TOKEN
            raise ValueError(f"No vector DB configuration found for customer {customer_id}")
            
        encrypted_endpoint = item.get('endpoint')
        encrypted_token = item.get('token')
        
        if not encrypted_endpoint or not encrypted_token:
            if GLOBAL_ZILLIZ_ENDPOINT and GLOBAL_ZILLIZ_TOKEN:
                logger.info(f"Incomplete vector DB config for {customer_id}, using environment fallback")
                return GLOBAL_ZILLIZ_ENDPOINT, GLOBAL_ZILLIZ_TOKEN
            raise ValueError(f"Incomplete Zilliz configuration for customer {customer_id}")
            
        endpoint_bytes = base64.b64decode(encrypted_endpoint)
        decrypted_endpoint = kms_client.decrypt(CiphertextBlob=endpoint_bytes)['Plaintext'].decode('utf-8')
        
        token_bytes = base64.b64decode(encrypted_token)
        decrypted_token = kms_client.decrypt(CiphertextBlob=token_bytes)['Plaintext'].decode('utf-8')
        
        return decrypted_endpoint, decrypted_token
    except Exception as e:
        logger.error(f"Failed to fetch Zilliz credentials for {customer_id}: {str(e)}")
        if GLOBAL_ZILLIZ_ENDPOINT and GLOBAL_ZILLIZ_TOKEN:
            logger.info(f"Using environment fallback due to error for {customer_id}")
            return GLOBAL_ZILLIZ_ENDPOINT, GLOBAL_ZILLIZ_TOKEN
        raise e


def get_milvus_client(customer_id: str):
    """
    Creates and returns an authenticated MilvusClient for the given customer.
    Credentials are fetched via get_zilliz_credentials.
    """
    zilliz_endpoint, zilliz_token = get_zilliz_credentials(customer_id)

    zilliz_endpoint = zilliz_endpoint.rstrip('/')
    if zilliz_endpoint.startswith("https://") and zilliz_endpoint.count(":") == 1:
        zilliz_endpoint = f"{zilliz_endpoint}:443"

    try:
        from pymilvus import MilvusClient
        client = MilvusClient(
            uri=zilliz_endpoint,
            token=zilliz_token,
            timeout=10.0,
            secure=zilliz_endpoint.startswith("https://")
        )
        logger.info(f"MilvusClient connected for customer {customer_id}")
        return client
    except Exception as e:
        logger.error(f"Failed to connect to Milvus for customer {customer_id}: {e}")
        raise
