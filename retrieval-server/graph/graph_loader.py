import logging
import os
import time
from typing import Optional

import boto3
from boto3.dynamodb.conditions import Attr, Key

logger = logging.getLogger(__name__)

_dynamodb = None

# Owner id of the admin-published default graph. Customers without an own
# default graph fall back to it; their first edit forks it server-side into a
# customer-owned copy (handled by the Kotlin proxy server).
SYSTEM_GRAPH_OWNER = "System"

# Short TTL instead of process-lifetime caching: customer forks and System
# publishes must take effect without a restart. One entry per owner id
# (customers and SYSTEM_GRAPH_OWNER alike): owner -> (loaded_at, result).
_CACHE_TTL_SECONDS = 60
_graph_cache: dict[str, tuple[float, Optional[tuple[dict, list[dict]]]]] = {}


def _get_dynamodb():
    global _dynamodb
    if _dynamodb is None:
        region = os.getenv("AWS_REGION", "us-east-1")
        _dynamodb = boto3.resource("dynamodb", region_name=region)
    return _dynamodb


def _load_default_graph(owner_id: str) -> Optional[tuple[dict, list[dict]]]:
    """
    Load an owner's default graph and its nodes from DDB (no caching).

    Schema: PK=graphId/nodeId, SK=version (Number). version=0 is always the
    current/live item. The customerIdIndex GSI only indexes v=0 items
    (sparse: history items omit customerId).
    """
    db = _get_dynamodb()

    # Sparse GSI query — all results are v=0 (current) items.
    graphs_table = db.Table("CustomerGraphs")
    response = graphs_table.query(
        IndexName="customerIdIndex",
        KeyConditionExpression=Key("customerId").eq(owner_id),
        FilterExpression=Attr("isDefault").eq(True) & Attr("deletedAt").not_exists(),
        Limit=20,
    )
    items = response.get("Items", [])
    if not items:
        return None

    graph_record = items[0]
    node_ids = graph_record.get("nodeIds", [])
    if not node_ids:
        logger.warning("Default graph for owner=%s has no nodeIds", owner_id)
        return None

    nodes = _load_nodes(db, node_ids)

    logger.info(
        "Loaded default graph=%s with %d nodes for owner=%s",
        graph_record.get("graphId"), len(nodes), owner_id,
    )
    return (graph_record, nodes)


def _load_nodes(db, node_ids: list) -> list[dict]:
    """BatchGet v=0 for all nodes — single round trip; soft-deleted filtered."""
    batch_response = db.batch_get_item(
        RequestItems={
            "CustomerGraphNodes": {
                "Keys": [
                    {"nodeId": nid, "version": 0}
                    for nid in node_ids
                ]
            }
        }
    )
    nodes = batch_response.get("Responses", {}).get("CustomerGraphNodes", [])
    return [n for n in nodes if "deletedAt" not in n]


def _load_graph_by_id(graph_id: str) -> Optional[tuple[dict, list[dict]]]:
    """Load one graph (any owner) + its nodes by graphId, no caching."""
    db = _get_dynamodb()
    graph_record = (
        db.Table("CustomerGraphs")
        .get_item(Key={"graphId": graph_id, "version": 0})
        .get("Item")
    )
    if not graph_record or "deletedAt" in graph_record:
        return None
    node_ids = graph_record.get("nodeIds", [])
    if not node_ids:
        logger.warning("Graph %s has no nodeIds", graph_id)
        return None
    nodes = _load_nodes(db, node_ids)
    logger.info("Loaded graph=%s with %d nodes", graph_id, len(nodes))
    return (graph_record, nodes)


def _get_cached(cache_key: str, loader) -> Optional[tuple[dict, list[dict]]]:
    now = time.monotonic()
    cached = _graph_cache.get(cache_key)
    if cached and now - cached[0] < _CACHE_TTL_SECONDS:
        return cached[1]
    try:
        result = loader()
        _graph_cache[cache_key] = (now, result)
        return result
    except Exception:
        logger.exception("Failed to load graph for key=%s", cache_key)
        # Serve stale data over failing the request when we have it.
        return cached[1] if cached else None


def _get_cached_default_graph(owner_id: str) -> Optional[tuple[dict, list[dict]]]:
    return _get_cached(owner_id, lambda: _load_default_graph(owner_id))


def get_graph_and_nodes_by_id(graph_id: str) -> Optional[tuple[dict, list[dict]]]:
    """
    A specific graph by id (any owner — used to execute request agents through
    the LangGraph runtime). Same TTL caching as the default-graph lookups; the
    "graph#" prefix keeps the cache keys clear of owner ids.
    """
    return _get_cached(f"graph#{graph_id}", lambda: _load_graph_by_id(graph_id))


def get_default_graph_and_nodes(customer_id: str) -> Optional[tuple[dict, list[dict]]]:
    """
    The graph to run for a customer: their own default graph when they have
    one, otherwise the System-published default graph. Returns
    (graph_record, nodes) or None when neither exists (caller falls back to
    the direct single-LLM pipeline).
    """
    own = _get_cached_default_graph(customer_id)
    if own is not None:
        return own
    return _get_cached_default_graph(SYSTEM_GRAPH_OWNER)


def invalidate_cache(customer_id: str) -> None:
    """Remove a customer's cached graph so it is reloaded on the next request."""
    _graph_cache.pop(customer_id, None)
