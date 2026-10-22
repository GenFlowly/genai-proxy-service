"""
Resolve a customer's THIRD-PARTY TOOL credentials at call time from DynamoDB.

Sibling of graph/credentials.py, which does the same job for LLM vendor keys.
The rules are identical and deliberate:

  * resolved at call time, never carried in graph state — RetrievalState is the
    LangGraph checkpointer's channel schema and is written to Postgres on every
    durable super-step (see DURABLE_AGENTS_DBOS_PLAN.md §5.5),
  * never placed in a process environment variable — this service runs one
    uvicorn process on one event loop, so os.environ is shared by every
    concurrent tenant and a per-customer value there would be a cross-tenant
    key swap under load, not merely a race,
  * memoized for the lifetime of one resolver instance so a looping agent does
    a single DynamoDB + KMS round trip per credential rather than one per call.

Storage mirrors the Kotlin proxy's `CustomerToolCredentials` table, written by
CustomerCredentialsService.storeToolCredentials:
  PK = customerId
  SK = toolType     — the credential reference, e.g. "WEB_SEARCH"
  credentials       — base64 KMS ciphertext of a JSON object of string values
  authType          — "api_key" | "oauth2" (oauth2 blobs additionally carry
                      refresh_token / access_token / access_token_expiry;
                      refresh is the proxy's job, not this module's)
  settings          — OPTIONAL plain-JSON object of NON-SECRET per-tool config
                      the customer set in Settings → Tools (e.g. WEB_SEARCH's
                      "max_searches_per_turn"). Never encrypted, may exist on
                      an item that stores no credentials at all (a customer on
                      the platform key tuning limits), and is fetched in the
                      same GetItem as the credentials — no extra round trip.

Decryption uses the generic KMS decrypt (the CMK id is embedded in the
ciphertext blob, so no key id is passed), identical to graph/credentials.py
and to KMSProvider on the Kotlin side.
"""
import base64
import json
import logging
import os
from typing import Iterable, Optional

import boto3

logger = logging.getLogger(__name__)

# Table holding per-customer third-party tool credentials. Overridable for
# tests/other envs; defaults to the proxy's table name.
TOOL_CREDS_TABLE_NAME = os.environ.get(
    "CUSTOMER_TOOL_CREDENTIAL_TABLE", "CustomerToolCredentials"
)


class ToolCredentialResolver:
    """
    Per-run resolver for a customer's tool credentials.

    Create ONE instance per graph run and reuse it across tool calls: it
    memoizes each decrypted blob for the resolver's lifetime. The instance (and
    its decrypted secrets) lives only for the run and must never be placed in
    graph state or a DBOS workflow input/step output — all of those are
    checkpointed to Postgres.

    Every lookup is blocking boto3, so callers on the event loop must invoke
    `resolve` through asyncio.to_thread (the tool executor does).
    """

    def __init__(self, dynamodb_resource=None, kms_client=None):
        self._ddb = dynamodb_resource
        self._kms = kms_client
        # (customer_id, credential_ref) -> (secret values, plain settings)
        # ({}, {}) for a miss, cached too.
        self._cache: dict[tuple[str, str], tuple[dict, dict]] = {}

    def _clients(self):
        if self._ddb is None or self._kms is None:
            region = os.getenv("AWS_REGION", "us-east-1")
            if self._ddb is None:
                self._ddb = boto3.resource("dynamodb", region_name=region)
            if self._kms is None:
                self._kms = boto3.client("kms", region_name=region)
        return self._ddb, self._kms

    @staticmethod
    def _parse_settings(raw, customer_id: str, credential_ref: str) -> dict:
        """Plain-JSON `settings` attribute → dict of strings; anything
        malformed degrades to {} (defaults apply) rather than raising — a bad
        stored setting must never take search down with it."""
        if not raw:
            return {}
        try:
            settings = json.loads(raw)
        except (TypeError, ValueError):
            logger.warning(
                "Malformed tool settings for customer=%s ref=%s — ignoring",
                customer_id, credential_ref,
            )
            return {}
        if not isinstance(settings, dict):
            logger.warning(
                "Tool settings for customer=%s ref=%s are not a JSON object — ignoring",
                customer_id, credential_ref,
            )
            return {}
        return {str(k): v for k, v in settings.items()}

    def _fetch(self, customer_id: str, credential_ref: str) -> tuple[dict, dict]:
        """One GetItem per (customer, ref) per resolver lifetime, yielding
        (decrypted secret values, plain settings). Settings may exist without
        credentials (a platform-key customer tuning limits), so they are read
        before the no-credentials early return."""
        if not customer_id or not credential_ref:
            return {}, {}
        cache_key = (customer_id, credential_ref)
        if cache_key in self._cache:
            return self._cache[cache_key]

        ddb, kms = self._clients()
        try:
            table = ddb.Table(TOOL_CREDS_TABLE_NAME)
            item = table.get_item(
                Key={"customerId": customer_id, "toolType": credential_ref}
            ).get("Item") or {}
        except Exception:
            logger.exception(
                "Failed to fetch tool credentials for customer=%s ref=%s",
                customer_id, credential_ref,
            )
            raise

        settings = self._parse_settings(item.get("settings"), customer_id, credential_ref)

        encrypted = item.get("credentials")
        if not encrypted:
            logger.info(
                "No stored tool credentials for customer=%s ref=%s", customer_id, credential_ref
            )
            self._cache[cache_key] = ({}, settings)
            return {}, settings

        try:
            plaintext = kms.decrypt(
                CiphertextBlob=base64.b64decode(encrypted)
            )["Plaintext"].decode("utf-8")
            values = json.loads(plaintext)
        except Exception:
            logger.exception(
                "Failed to KMS-decrypt tool credentials for customer=%s ref=%s",
                customer_id, credential_ref,
            )
            raise

        if not isinstance(values, dict):
            logger.error(
                "Stored tool credentials for customer=%s ref=%s are not a JSON object",
                customer_id, credential_ref,
            )
            values = {}

        # Values are strings on the Kotlin side (Map<String,String>); normalize
        # defensively so a tool can rely on .get() returning a string or None.
        values = {str(k): v for k, v in values.items()}
        self._cache[cache_key] = (values, settings)
        return values, settings

    def credentials(self, customer_id: str, credential_ref: str) -> dict:
        """The customer's decrypted values for `credential_ref`, or {} when the
        customer has stored none.

        A missing credential is NOT an error: tools degrade to a message the
        model can act on (see WebSearchTool.run), so an unconfigured tool never
        aborts a turn. Fetch/decrypt failures DO raise — those are real faults
        and the executor records them per call.
        """
        return self._fetch(customer_id, credential_ref)[0]

    def resolve(self, customer_id: str, refs: Iterable[str]) -> dict[str, dict]:
        """{credential_ref: values} for each requested ref. Blocking; call via
        asyncio.to_thread from async code."""
        return {ref: self.credentials(customer_id, ref) for ref in refs if ref}

    def resolve_with_settings(
        self, customer_id: str, refs: Iterable[str]
    ) -> tuple[dict[str, dict], dict[str, dict]]:
        """({ref: secret values}, {ref: plain settings}) for each requested
        ref, from the same single GetItem per ref. Blocking; call via
        asyncio.to_thread from async code."""
        creds: dict[str, dict] = {}
        settings: dict[str, dict] = {}
        for ref in refs:
            if not ref:
                continue
            creds[ref], settings[ref] = self._fetch(customer_id, ref)
        return creds, settings


# --- Module-level accessor used by the graph nodes -------------------------------
#
# boto3 clients are reused process-wide (creating them is expensive; they hold no
# secrets). Decryption is done per run with no cross-run plaintext cache.

_shared_ddb = None
_shared_kms = None


def _shared_clients():
    global _shared_ddb, _shared_kms
    if _shared_ddb is None or _shared_kms is None:
        region = os.getenv("AWS_REGION", "us-east-1")
        _shared_ddb = boto3.resource("dynamodb", region_name=region)
        _shared_kms = boto3.client("kms", region_name=region)
    return _shared_ddb, _shared_kms


# TODO: fetch through the Kotlin server's internal API instead of talking to
# DynamoDB/KMS directly, so the retrieval-server holds no AWS credentials at all
# (the same cutover graph/credentials.py notes for LLM vendor keys).
def make_resolver() -> ToolCredentialResolver:
    """A fresh per-run resolver over the process-wide boto3 clients."""
    ddb, kms = _shared_clients()
    return ToolCredentialResolver(dynamodb_resource=ddb, kms_client=kms)


def resolve_tool_credentials(customer_id: str, refs: Iterable[str]) -> dict[str, dict]:
    """Fetch + decrypt `refs` for one customer as {ref: values}. Blocking — call
    it via asyncio.to_thread from the event loop."""
    return make_resolver().resolve(customer_id, refs)


def resolve_tool_credentials_and_settings(
    customer_id: str, refs: Iterable[str]
) -> tuple[dict[str, dict], dict[str, dict]]:
    """Fetch `refs` for one customer as ({ref: secret values}, {ref: plain
    settings}) in a single pass. Blocking — call via asyncio.to_thread."""
    return make_resolver().resolve_with_settings(customer_id, refs)


def secrets_accessor(resolved: dict[str, dict]):
    """Wrap an already-resolved {ref: values} map as the callable ToolContext
    expects, so tools never trigger I/O themselves."""

    def secrets(credential_ref: Optional[str]) -> dict:
        if not credential_ref:
            return {}
        return resolved.get(credential_ref) or {}

    return secrets
