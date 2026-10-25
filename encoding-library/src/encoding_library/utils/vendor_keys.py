"""
Per-customer embedding-provider API keys, read from the proxy's
CustomerVendorApiKeys table (PK customerId, SK aiVendor) and KMS-decrypted.

Embedding providers map to the vendor names the Kotlin proxy stores (its
EmbeddingVendor enum): openai -> OPENAI (one row shared with the
text-generation key), voyage -> VOYAGE (embedding-only row). Local
sentence-transformer models need no key.

There is deliberately no environment-variable fallback: a customer without a
stored key cannot embed with hosted models (get_embedding_model raises
EmbeddingKeyMissing).
"""
import base64
import logging
import os
from typing import Optional

import boto3

logger = logging.getLogger(__name__)

CREDS_TABLE_NAME = os.environ.get("CUSTOMER_API_KEY_TABLE", "CustomerVendorApiKeys")

_PROVIDER_TO_VENDOR = {"openai": "OPENAI", "voyage": "VOYAGE"}

_dynamodb = None
_kms = None


def _clients():
    global _dynamodb, _kms
    region = os.environ.get("AWS_REGION", "us-east-1")
    if _dynamodb is None:
        _dynamodb = boto3.resource("dynamodb", region_name=region)
    if _kms is None:
        _kms = boto3.client("kms", region_name=region)
    return _dynamodb, _kms


def provider_needs_key(model_type: Optional[str]) -> bool:
    """True for hosted embedding providers (voyage/openai); False for local
    sentence-transformer models."""
    return (model_type or "").lower() in _PROVIDER_TO_VENDOR


def get_customer_embedding_key(customer_id: str, model_type: Optional[str]) -> Optional[str]:
    """
    The customer's decrypted API key for a hosted embedding provider, or None
    when the provider needs no key or the customer has not stored one.

    DynamoDB/KMS failures propagate — a missing key is a customer state, an
    unreachable credentials store is an infrastructure error.
    """
    vendor = _PROVIDER_TO_VENDOR.get((model_type or "").lower())
    if not vendor:
        return None
    dynamodb, kms = _clients()
    table = dynamodb.Table(CREDS_TABLE_NAME)
    response = table.get_item(Key={"customerId": customer_id, "aiVendor": vendor})
    encrypted = (response.get("Item") or {}).get("apiKey")
    if not encrypted:
        return None
    plaintext = (
        kms.decrypt(CiphertextBlob=base64.b64decode(encrypted))["Plaintext"].decode("utf-8")
    )
    return plaintext or None
