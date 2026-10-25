import os
import logging
import base64
import boto3
from typing import Tuple

from encoding_library.observability import count
from encoding_library.utils.retry import RetryingProxy, retry_call

logger = logging.getLogger(__name__)

region_name = os.environ.get('AWS_REGION', 'us-east-1')
dynamodb = boto3.resource('dynamodb', region_name=region_name)
kms_client = boto3.client('kms', region_name=region_name)

VECTOR_DB_TABLE_NAME = os.environ.get('CUSTOMER_VECTOR_DB_CONFIG_TABLE', 'CustomerVectorDBConfig')
vector_db_table = dynamodb.Table(VECTOR_DB_TABLE_NAME)


class VectorDBNotConfigured(Exception):
    """The customer has no (or an incomplete) CustomerVectorDBConfig row — a
    customer state, not an infrastructure failure. There is no platform-wide
    fallback vector DB; a real DynamoDB/KMS failure propagates as its own
    exception instead of being folded into this one."""

    def __init__(self, customer_id: str):
        self.customer_id = customer_id
        super().__init__(f"No vector DB configured for customer '{customer_id}'.")


def get_zilliz_credentials(customer_id: str) -> Tuple[str, str]:
    """
    Fetches this customer's Zilliz endpoint and token from DynamoDB, decrypting
    them with KMS. Raises VectorDBNotConfigured when the customer has no (or
    an incomplete) config row; any other failure (DynamoDB/KMS unreachable)
    propagates as-is.
    """
    response = vector_db_table.get_item(Key={'customerId': customer_id})
    item = response.get('Item')
    if not item or not item.get('endpoint') or not item.get('token'):
        count("vector_db_not_configured_total")
        raise VectorDBNotConfigured(customer_id)

    decrypted_endpoint = kms_client.decrypt(
        CiphertextBlob=base64.b64decode(item['endpoint'])
    )['Plaintext'].decode('utf-8')
    decrypted_token = kms_client.decrypt(
        CiphertextBlob=base64.b64decode(item['token'])
    )['Plaintext'].decode('utf-8')
    return decrypted_endpoint, decrypted_token


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
        client = retry_call(
            MilvusClient,
            uri=zilliz_endpoint,
            token=zilliz_token,
            timeout=10.0,
            secure=zilliz_endpoint.startswith("https://"),
            operation="milvus.connect",
        )
        logger.info(f"MilvusClient connected for customer {customer_id}")
        # Every Milvus call (search/insert/delete/...) retries with backoff.
        return RetryingProxy(client, operation="milvus")
    except Exception as e:
        logger.error(f"Failed to connect to Milvus for customer {customer_id}: {e}")
        raise


# ── Shared multi-tenant collections ──────────────────────────────────────────
#
# One collection per (data type, embedding model), shared by every customer on
# the cluster: '{type_token}_{model_name_with_underscores}' (e.g.
# 'notes_voyage_4_large'). Tenancy lives in the customer_id partition-key
# field on every row, so EVERY search/query/delete on a shared collection must
# carry a customer_id filter — build it with customer_filter(). This replaces
# the per-customer '{customerId}_{type}_{model}' naming, which needed
# customers × types collections and exceeded Zilliz's per-DB collection quota.

CUSTOMER_ID_FIELD = "customer_id"
CUSTOMER_ID_MAX_LENGTH = 64

# First '_'-segment of a shared collection name → the data type it holds.
KNOWN_TYPE_TOKENS = ("email", "notes", "memory", "conversation", "instructions")


def shared_collection_name(type_token: str, model_name: str = None) -> str:
    """Shared collection for a data type + embedding model (platform default
    model when None). type_token must be one of KNOWN_TYPE_TOKENS."""
    from encoding_library.utils.model_registry import resolve_model

    _, resolved_name = resolve_model(None, model_name)
    return f"{type_token}_{resolved_name.replace('-', '_')}"


def collection_data_type(name: str) -> str:
    """Data-type token of a shared collection name, or None for anything else
    (legacy per-customer collections, unknown names)."""
    token = name.split("_", 1)[0]
    return token if token in KNOWN_TYPE_TOKENS else None


def escape_filter_value(value: str) -> str:
    """Escape a string for safe interpolation into a Milvus filter expression."""
    return value.replace("\\", "\\\\").replace('"', '\\"')


def customer_filter(customer_id: str, extra: str = None) -> str:
    """Milvus filter expression scoping an operation to one customer's rows,
    optionally AND-ed with an extra expression. Including the partition-key
    equality lets Milvus prune to the customer's partition."""
    base = f'{CUSTOMER_ID_FIELD} == "{escape_filter_value(customer_id)}"'
    return f"{base} and ({extra})" if extra else base


def add_customer_id_field(schema) -> None:
    """Add the customer_id partition-key field to a collection schema. Every
    shared-collection schema must include this."""
    from pymilvus import DataType

    schema.add_field(
        field_name=CUSTOMER_ID_FIELD,
        datatype=DataType.VARCHAR,
        max_length=CUSTOMER_ID_MAX_LENGTH,
        is_partition_key=True,
    )


def ensure_collection(client, collection_name: str, schema, index_params) -> bool:
    """Create a collection if missing, tolerating a concurrent creator (two
    lambdas racing the same first write). Returns True when this call created
    it."""
    if client.has_collection(collection_name):
        return False
    try:
        client.create_collection(
            collection_name=collection_name, schema=schema, index_params=index_params
        )
        return True
    except Exception:
        # Lost a creation race → the collection exists now; anything else is a
        # real failure the caller must see.
        if client.has_collection(collection_name):
            logger.info(f"Collection '{collection_name}' was created concurrently")
            return False
        raise
