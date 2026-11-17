"""Scheduled Zilliz heartbeat: one real read a day against every customer's
connected cluster, so a Zilliz free cluster never sits through the 7 days of
inactivity after which Zilliz suspends it while the customer is away.

Zilliz doesn't define which calls count as activity, so the ping is a one-row
query on one of the customer's shared collections rather than a metadata-only
call; a cluster with no shared collections yet only gets list_collections.
A cluster that is already suspended can't be woken from here (Zilliz's resume
API is dedicated-cluster only): its pings fail until the customer resumes it
from the Zilliz console.

The calls stay out of the customer's Cost and Usage rollup
(record_usage=False): the customer never asked for them.
"""
import logging
import random
from collections import Counter
from typing import Any, Dict, List

from encoding_library.observability import count, setup_logging, track
from encoding_library.utils.vector_db import (
    CUSTOMER_ID_FIELD,
    VectorDBNotConfigured,
    collection_data_type,
    customer_filter,
    get_milvus_client,
    vector_db_table,
)
from services.content_logging import default_log_level

setup_logging("encoding-server", level=default_log_level())
logger = logging.getLogger()

CALL_TIMEOUT_SECONDS = 10.0
# A ping against an unreachable cluster can spend ~40 s in connect/call
# retries; stop starting new pings once less than this is left so the run
# ends with its summary instead of a Lambda timeout.
STOP_WHEN_REMAINING_MS = 60_000


def _customer_ids() -> List[str]:
    ids: List[str] = []
    kwargs: Dict[str, Any] = {"ProjectionExpression": "customerId"}
    while True:
        page = vector_db_table.scan(**kwargs)
        ids.extend(item["customerId"] for item in page.get("Items", []) if item.get("customerId"))
        if "LastEvaluatedKey" not in page:
            return ids
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def _ping(customer_id: str) -> str:
    try:
        client = get_milvus_client(customer_id, record_usage=False)
        shared = sorted(
            name for name in client.list_collections(timeout=CALL_TIMEOUT_SECONDS)
            if collection_data_type(name)
        )
        if not shared:
            return "no_collections"
        client.query(
            collection_name=shared[0],
            filter=customer_filter(customer_id),
            output_fields=[CUSTOMER_ID_FIELD],
            limit=1,
            timeout=CALL_TIMEOUT_SECONDS,
        )
        return "ok"
    except VectorDBNotConfigured:
        return "not_configured"
    except Exception as e:
        logger.warning("Zilliz heartbeat failed for customer %s: %s: %s", customer_id, type(e).__name__, e)
        return "error"


@track("zilliz_heartbeat")
def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    customer_ids = _customer_ids()
    # Shuffled so that if a run does stop early, the same customers aren't
    # the ones skipped every day.
    random.shuffle(customer_ids)

    statuses: Counter = Counter()
    for customer_id in customer_ids:
        if context is not None and context.get_remaining_time_in_millis() < STOP_WHEN_REMAINING_MS:
            statuses["skipped"] += len(customer_ids) - sum(statuses.values())
            break
        statuses[_ping(customer_id)] += 1

    for status, n in statuses.items():
        count("zilliz_heartbeat_total", n, status=status)
    logger.info("Zilliz heartbeat over %d customer(s): %s", len(customer_ids), dict(statuses))
    return {"customers": len(customer_ids), "statuses": dict(statuses)}
