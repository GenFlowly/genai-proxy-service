"""Load a customer's declarative tool records from DynamoDB.

Sibling of graph/graph_loader.py and cached the same way and for the same
reason: a short TTL rather than process-lifetime caching, so a tool a customer
just saved takes effect without a restart, while a looping agent does not
re-read the table on every turn.

These records carry NO secrets — only a `credentialRef` naming a row in
CustomerToolCredentials — so caching them is safe and they may be logged.
Credentials are resolved separately, per request, by graph/tool_credentials.py.

Only `active` rows are ever returned. A `draft` tool is one the customer has
not yet proved with a dry run, and a `disabled` one is deliberately off; in
both cases the model must not see it.
"""
import logging
import os
import time
from typing import Optional

import boto3
from boto3.dynamodb.conditions import Key

from graph_tools.providers import HttpTool, ToolDefinitionError

logger = logging.getLogger(__name__)

TOOLS_TABLE_NAME = os.environ.get("CUSTOMER_TOOLS_TABLE", "CustomerTools")

# Matches graph_loader's TTL: long enough to spare the table during an agent
# loop, short enough that an edit lands without a deploy.
_CACHE_TTL_SECONDS = 60
_cache: dict[str, tuple[float, list[dict]]] = {}

_dynamodb = None

# provider value -> the class that interprets a record. The seam: an "mcp"
# provider is added here and nothing else in the graph changes.
_PROVIDERS = {"http": HttpTool}


def _get_dynamodb():
    global _dynamodb
    if _dynamodb is None:
        region = os.getenv("AWS_REGION", "us-east-1")
        _dynamodb = boto3.resource("dynamodb", region_name=region)
    return _dynamodb


def _load_records(customer_id: str) -> list[dict]:
    table = _get_dynamodb().Table(TOOLS_TABLE_NAME)
    response = table.query(
        KeyConditionExpression=Key("customerId").eq(customer_id),
        Limit=100,
    )
    records = [r for r in response.get("Items", []) if r.get("status") == "active"]
    logger.info(
        "Loaded %d active tool record(s) for customer=%s", len(records), customer_id
    )
    return records


def records_for(customer_id: str) -> list[dict]:
    """A customer's active tool records, TTL-cached.

    A load failure serves stale records when we have them and an empty list
    otherwise: losing a custom tool should degrade the answer, never fail the
    request.
    """
    if not customer_id:
        return []
    now = time.monotonic()
    cached = _cache.get(customer_id)
    if cached and now - cached[0] < _CACHE_TTL_SECONDS:
        return cached[1]
    try:
        records = _load_records(customer_id)
        _cache[customer_id] = (now, records)
        return records
    except Exception:
        logger.exception("Failed to load tool records for customer=%s", customer_id)
        return cached[1] if cached else []


def build_tool(record: dict) -> Optional[object]:
    """Interpret one record, or None when it is unusable.

    A malformed record is dropped with a warning rather than raised: one bad
    tool must not take down a customer's whole agent.
    """
    provider = (record.get("provider") or "http").lower()
    cls = _PROVIDERS.get(provider)
    if cls is None:
        logger.warning(
            "Tool '%s' uses unknown provider '%s' — dropped",
            record.get("name"), provider,
        )
        return None
    try:
        return cls(record)
    except ToolDefinitionError as e:
        logger.warning("Tool '%s' is not a valid definition — dropped (%s)",
                       record.get("name"), e)
        return None
    except Exception:
        logger.exception("Tool '%s' could not be built — dropped", record.get("name"))
        return None


def tools_for_customer(customer_id: str, names: set[str]) -> dict[str, object]:
    """{name: tool} for the requested names that this customer actually has."""
    if not customer_id or not names:
        return {}
    built: dict[str, object] = {}
    for record in records_for(customer_id):
        name = record.get("name")
        if name not in names or name in built:
            continue
        tool = build_tool(record)
        if tool is not None:
            built[name] = tool
    return built


def invalidate(customer_id: str) -> None:
    """Drop a customer's cached records (e.g. right after they save a tool)."""
    _cache.pop(customer_id, None)
