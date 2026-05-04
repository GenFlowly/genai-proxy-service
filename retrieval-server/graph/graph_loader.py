import logging
import os
from typing import Optional

import boto3
from boto3.dynamodb.conditions import Attr, Key

logger = logging.getLogger(__name__)

_dynamodb = None

# In-memory cache: customer_id -> (graph_record, nodes_list)
# Invalidated on process restart or explicit cache clear.
_graph_cache: dict[str, tuple[dict, list[dict]]] = {}


def _get_dynamodb():
    global _dynamodb
    if _dynamodb is None:
        region = os.getenv("AWS_REGION", "us-east-1")
        _dynamodb = boto3.resource("dynamodb", region_name=region)
    return _dynamodb


def get_default_graph_and_nodes(customer_id: str) -> Optional[tuple[dict, list[dict]]]:
    """
    Load the customer's default graph and its nodes from DDB.

    Schema: PK=graphId/nodeId, SK=version (Number).
    version=0 is always the current/live item. The customerIdIndex GSI
    only indexes v=0 items (sparse: history items omit customerId).

    Returns (graph_record, nodes) or None if no default graph exists.
    Results are cached in memory for the lifetime of the process.
    """
    if customer_id in _graph_cache:
        return _graph_cache[customer_id]

    try:
        db = _get_dynamodb()

        # Sparse GSI query — all results are v=0 (current) items.
        graphs_table = db.Table("CustomerGraphs")
        response = graphs_table.query(
            IndexName="customerIdIndex",
            KeyConditionExpression=Key("customerId").eq(customer_id),
            FilterExpression=Attr("isDefault").eq(True) & Attr("deletedAt").not_exists(),
            Limit=20,
        )
        items = response.get("Items", [])
        if not items:
            logger.info("No default graph found for customer=%s", customer_id)
            return None

        graph_record = items[0]
        node_ids = graph_record.get("nodeIds", [])

        if not node_ids:
            logger.warning("Default graph for customer=%s has no nodeIds", customer_id)
            return None

        # BatchGet v=0 for all nodes — single round trip.
        nodes_table = db.Table("CustomerGraphNodes")
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
        # Filter soft-deleted nodes
        nodes = [n for n in nodes if "deletedAt" not in n]

        result = (graph_record, nodes)
        _graph_cache[customer_id] = result
        logger.info(
            "Loaded default graph=%s with %d nodes for customer=%s",
            graph_record.get("graphId"),
            len(nodes),
            customer_id,
        )
        return result

    except Exception:
        logger.exception("Failed to load default graph for customer=%s", customer_id)
        return None


def invalidate_cache(customer_id: str) -> None:
    """Remove a customer's cached graph so it is reloaded on the next request."""
    _graph_cache.pop(customer_id, None)
