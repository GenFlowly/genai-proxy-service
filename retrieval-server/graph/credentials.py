"""
Resolve a customer's LLM API credentials at call time from DynamoDB, so secrets
never travel in graph state (and therefore can never land in a checkpoint once
durable runs exist — see DURABLE_AGENTS_DBOS_PLAN.md §5.5).

Storage mirrors the Kotlin proxy's `CustomerVendorApiKeys` table:
  PK = customerId
  SK = aiVendor  — the stored vendor name: legacy vendors are the uppercase
                   OPENAI / CLAUDE / GEMINI; every other (BYOK) vendor is its
                   lowercase LiteLLM provider id (e.g. "groq", "xai").
  apiKey         — the API key, base64-encoded KMS ciphertext.

Decryption uses the generic KMS decrypt (the CMK id is embedded in the
ciphertext blob, so no key id is passed), identical to how
encoding_library.utils.vector_db decrypts the Zilliz credentials.

The returned dict uses the `{provider}_api_key` shape that
graph.llm_factory.get_llm reads (e.g. {"anthropic_api_key": "..."}).

NOTE: this module is not wired into the graph yet. The cutover — resolving
creds here instead of from state["llm_credentials"], and dropping that field
from RetrievalState — happens alongside the durable /runs work (P1c), when the
retrieval-server's IAM grant (dynamodb:GetItem on CustomerVendorApiKeys +
kms:Decrypt) can be confirmed and the path smoke-tested end to end.
"""
import base64
import logging
import os
from typing import Optional

import boto3

logger = logging.getLogger(__name__)

# Table holding per-customer vendor API keys. Overridable for tests/other envs;
# defaults to the proxy's table name.
CREDS_TABLE_NAME = os.environ.get("CUSTOMER_API_KEY_TABLE", "CustomerVendorApiKeys")

# Legacy vendors keep uppercase names as their DynamoDB sort key; every other
# provider is stored under its lowercase LiteLLM id. This mirrors AIVendor.of()
# in the Kotlin proxy, which is the single source of truth for the mapping.
_LEGACY_PROVIDER_TO_VENDOR = {
    "openai": "OPENAI",
    "anthropic": "CLAUDE",
    "gemini": "GEMINI",
}


def stored_vendor_key(provider: str) -> str:
    """Map an LLM provider id (as carried in llm_provider) to its stored
    CustomerVendorApiKeys sort key."""
    p = (provider or "").lower()
    return _LEGACY_PROVIDER_TO_VENDOR.get(p, p)


class CredentialResolver:
    """
    Per-run resolver for customer LLM credentials.

    Create ONE instance per graph run and reuse it across nodes: it memoizes
    each decrypted key for the resolver's lifetime, so a multi-node or looping
    graph does a single DynamoDB + KMS round-trip per provider rather than one
    per node. The instance (and its decrypted secrets) lives only for the run
    and must never be placed in graph state or a DBOS workflow input/step
    output — all of those get checkpointed to Postgres.
    """

    def __init__(self, dynamodb_resource=None, kms_client=None):
        self._ddb = dynamodb_resource
        self._kms = kms_client
        # (customer_id, stored_vendor_key) -> decrypted key or None (miss cached too)
        self._cache: dict[tuple[str, str], Optional[str]] = {}

    def _clients(self):
        if self._ddb is None or self._kms is None:
            region = os.getenv("AWS_REGION", "us-east-1")
            if self._ddb is None:
                self._ddb = boto3.resource("dynamodb", region_name=region)
            if self._kms is None:
                self._kms = boto3.client("kms", region_name=region)
        return self._ddb, self._kms

    def api_key(self, customer_id: str, provider: str) -> Optional[str]:
        """The customer's decrypted API key for `provider`, or None if unset."""
        vendor_key = stored_vendor_key(provider)
        cache_key = (customer_id, vendor_key)
        if cache_key in self._cache:
            return self._cache[cache_key]

        ddb, kms = self._clients()
        try:
            table = ddb.Table(CREDS_TABLE_NAME)
            item = table.get_item(Key={"customerId": customer_id, "aiVendor": vendor_key}).get("Item")
        except Exception:
            logger.exception(
                "Failed to fetch API key for customer=%s vendor=%s", customer_id, vendor_key
            )
            raise

        encrypted = item.get("apiKey") if item else None
        if not encrypted:
            logger.warning("No stored API key for customer=%s vendor=%s", customer_id, vendor_key)
            self._cache[cache_key] = None
            return None

        try:
            plaintext = kms.decrypt(CiphertextBlob=base64.b64decode(encrypted))["Plaintext"].decode("utf-8")
        except Exception:
            logger.exception(
                "Failed to KMS-decrypt API key for customer=%s vendor=%s", customer_id, vendor_key
            )
            raise

        self._cache[cache_key] = plaintext
        return plaintext

    def credentials(self, customer_id: str, provider: str) -> dict:
        """The {f'{provider}_api_key': key} dict get_llm expects; empty when no
        key is stored for the customer/provider."""
        key = self.api_key(customer_id, provider)
        return {f"{provider}_api_key": key} if key else {}
