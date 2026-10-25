"""POST /purge-vectors: delete a customer's vectors when genai-proxy-server
purges the customer or one of their conversations (PDF plan 3.9).

Service-to-service only. Like every route here, API Gateway's Auth0 JWT
authorizer validates the token; this handler then accepts only an Auth0
client-credentials (machine-to-machine) token whose client id (azp) is listed
in PURGE_ALLOWED_CLIENT_IDS (comma-separated). User tokens are refused, and
with PURGE_ALLOWED_CLIENT_IDS unset every call is refused.

Body (JSON), exactly one action:
  {"customerId": "CU...", "conversationId": "<conversation id>"}
      deletes every vector with conversation_key == "<conversation id>" from
      the customer's conversation collections ({customerId}_conversation_*),
      where ConversationIndexingService stored the conversation's exchanges.
  {"customerId": "CU...", "dropCollections": true}
      drops every collection of the customer ({customerId}_*).

Both are idempotent: a missing collection or an already-deleted vector is not
an error, so the proxy re-runs a purge freely. Ids are validated before they
reach a collection-name prefix or a filter expression.
"""
import json
import logging
import os
import re
from typing import Any, Dict, List, Optional

from encoding_library.observability import (
    count,
    request_id_from_lambda_event,
    set_request_id,
    setup_logging,
    track,
)
from encoding_library.utils.vector_db import VectorDBNotConfigured, get_milvus_client
from handlers.http_metrics import track_http_status
from services.content_logging import default_log_level

setup_logging("encoding-server", level=default_log_level())
logger = logging.getLogger()

# No underscore: collection names are {customerId}_{type}_{model}, so the
# "{customerId}_" prefix can then never match another customer's collections.
CUSTOMER_ID_PATTERN = re.compile(r"^[A-Za-z0-9-]{1,64}$")
# Conversation ids are UUIDs; nothing that could close the filter's quotes.
CONVERSATION_ID_PATTERN = re.compile(r"^[A-Za-z0-9-]{1,128}$")
# Pseudo-owners whose collections hold shared, not customer, data.
RESERVED_CUSTOMER_IDS = {"system", "public"}

CLIENT_CREDENTIALS_GRANT = "client-credentials"


def _response(status: int, body: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"},
        "body": json.dumps(body),
    }


def _allowed_client_ids() -> set:
    raw = os.environ.get("PURGE_ALLOWED_CLIENT_IDS", "")
    return {part.strip() for part in raw.split(",") if part.strip()}


def _authorize(event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """None when the caller is an allowed service client, else the 403 to return."""
    claims = (
        event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}).get("claims", {}) or {}
    )
    client_id = claims.get("azp") or claims.get("client_id")
    allowed = _allowed_client_ids()
    if not allowed:
        logger.warning("Purge refused: PURGE_ALLOWED_CLIENT_IDS is not configured")
        return _response(403, {"error": "Forbidden: purge is not enabled"})
    if claims.get("gty") != CLIENT_CREDENTIALS_GRANT or client_id not in allowed:
        logger.warning("Purge refused for a caller that is not an allowed service client")
        return _response(403, {"error": "Forbidden: service clients only"})
    return None


def _parse_body(event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    raw = event.get("body")
    if isinstance(raw, dict):
        return raw
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _delete_count(result: Any) -> int:
    """pymilvus returns {"delete_count": n} (a dict subclass); tolerate other shapes."""
    if isinstance(result, dict):
        value = result.get("delete_count", 0)
    else:
        value = getattr(result, "delete_count", 0)
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _collections_with_prefix(client: Any, prefix: str) -> List[str]:
    return sorted(name for name in client.list_collections() if str(name).startswith(prefix))


@track("purge_vectors")
@track_http_status("purge_vectors")
def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    action = "invalid"
    try:
        set_request_id(request_id_from_lambda_event(event))
        # The raw event carries the Authorization header: shape only
        logger.info("Received purge request — keys=%s", sorted(event.keys()))

        denied = _authorize(event)
        if denied is not None:
            return denied

        body = _parse_body(event)
        if body is None:
            return _response(400, {"error": "Body must be a JSON object"})
        customer_id = body.get("customerId", body.get("customer_id"))
        conversation_id = body.get("conversationId", body.get("conversation_id"))
        drop = body.get("dropCollections", body.get("drop_collections")) is True

        if not isinstance(customer_id, str) or not CUSTOMER_ID_PATTERN.match(customer_id) \
                or customer_id.lower() in RESERVED_CUSTOMER_IDS:
            return _response(400, {"error": "customerId is missing or invalid"})
        if (conversation_id is not None) == drop:
            return _response(400, {"error": "Send exactly one of conversationId or dropCollections=true"})
        if conversation_id is not None and (
            not isinstance(conversation_id, str) or not CONVERSATION_ID_PATTERN.match(conversation_id)
        ):
            return _response(400, {"error": "conversationId is invalid"})

        client = get_milvus_client(customer_id)

        if conversation_id is not None:
            action = "delete_conversation"
            collections = _collections_with_prefix(client, f"{customer_id}_conversation_")
            deleted = 0
            for name in collections:
                result = client.delete(
                    collection_name=name, filter=f'conversation_key == "{conversation_id}"'
                )
                deleted += _delete_count(result)
            count("vector_purge_total", operation=action, status="ok")
            logger.info(
                "Purged conversation %s vectors of customer %s: %d deleted across %d collection(s)",
                conversation_id, customer_id, deleted, len(collections),
            )
            return _response(200, {"action": action, "collections": collections, "deleted": deleted})

        action = "drop_collections"
        collections = _collections_with_prefix(client, f"{customer_id}_")
        for name in collections:
            client.drop_collection(collection_name=name)
        count("vector_purge_total", operation=action, status="ok")
        logger.info("Dropped %d collection(s) of customer %s", len(collections), customer_id)
        return _response(200, {"action": action, "dropped": collections})

    except VectorDBNotConfigured:
        # No vector DB means nothing was ever stored — purge is a no-op,
        # matching the idempotent "nothing to delete" contract above.
        count("vector_purge_total", operation=action, status="ok")
        logger.info("No vector DB configured for customer %s; nothing to purge", customer_id)
        return _response(200, {"action": action, "deleted": 0})
    except Exception as e:
        count("vector_purge_total", operation=action, status="error")
        logger.error("Vector purge failed: %s", type(e).__name__, exc_info=True)
        return _response(500, {"error": "Internal server error"})
