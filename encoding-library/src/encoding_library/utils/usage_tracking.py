import os
import logging
from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional

import boto3

logger = logging.getLogger(__name__)

region_name = os.environ.get('AWS_REGION', 'us-east-1')
dynamodb = boto3.resource('dynamodb', region_name=region_name)

CUSTOMER_API_USAGE_TABLE_NAME = os.environ.get('CUSTOMER_API_USAGE_TABLE', 'CustomerAIUsage')
customer_api_usage_table = dynamodb.Table(CUSTOMER_API_USAGE_TABLE_NAME)


def _today_iso() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def record_embedding_usage(
    customer_id: str,
    vendor: str,
    model: str,
    total_tokens: Optional[int],
    cost_usd: Optional[float],
) -> None:
    """
    Fans one embedding call's usage into the CustomerAIUsage rollup — the
    Python-side counterpart of genai-proxy-server's
    UsageRollupRepository.incrementLlmUsage, same composite-sort-key scheme:
    "{date}#embedding#{vendor}#{model}". Best-effort: never let a usage
    write failure break the embedding call it's instrumenting.
    """
    if not customer_id or not vendor or not model:
        return
    sort_key = f"{_today_iso()}#embedding#{vendor}#{model}"

    update_expression_parts = ["SET #cat = :cat, #ven = :ven, #d3 = :d3"]
    add_parts = ["requestCount :one"]
    names = {"#cat": "category", "#ven": "vendor", "#d3": "dim3"}
    values: dict = {
        ":cat": "embedding",
        ":ven": vendor,
        ":d3": model,
        ":one": 1,
    }
    if total_tokens:
        add_parts.append("totalTokens :tokens")
        values[":tokens"] = int(total_tokens)
    if cost_usd is not None:
        add_parts.append("costUsd :cost")
        # boto3's resource-level Table API rejects native floats for Number
        # attributes ("Float types are not supported. Use Decimal types
        # instead.") — str() first avoids binary-float representation noise.
        values[":cost"] = Decimal(str(cost_usd))

    update_expression_parts.append(f"ADD {', '.join(add_parts)}")

    try:
        customer_api_usage_table.update_item(
            Key={'customerId': customer_id, 'usageDate': sort_key},
            UpdateExpression=' '.join(update_expression_parts),
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
        )
    except Exception:
        logger.warning(
            "Failed to record embedding usage for customer=%s vendor=%s model=%s",
            customer_id, vendor, model, exc_info=True,
        )


# Vector DB rows have no real per-request vendor price (the customer's own
# Zilliz cluster — we never see their bill), so only raw op counts are
# written here. genai-proxy-server's UsageSummaryService prices them at READ
# time against UsageRateCard; this module stays pricing-unaware on purpose.
_VECTOR_DB_VENDOR = "milvus"


def record_vector_db_op(customer_id: str, op_type: str) -> None:
    """
    Fans one Milvus operation into the CustomerAIUsage rollup — called for
    BOTH successful and failed-after-retries operations (see
    retry.RetryingProxy's on_complete hook, wired in vector_db.py): a failed
    op still consumed real Zilliz compute on each attempt, so counting only
    successes would under-report usage. Best-effort: never let a usage write
    failure break the Milvus call it's instrumenting.
    """
    if not customer_id or not op_type:
        return
    sort_key = f"{_today_iso()}#vector_db#{_VECTOR_DB_VENDOR}#{op_type}"

    try:
        customer_api_usage_table.update_item(
            Key={'customerId': customer_id, 'usageDate': sort_key},
            UpdateExpression="SET #cat = :cat, #ven = :ven, #d3 = :d3 ADD opCount :one",
            ExpressionAttributeNames={"#cat": "category", "#ven": "vendor", "#d3": "dim3"},
            ExpressionAttributeValues={
                ":cat": "vector_db",
                ":ven": _VECTOR_DB_VENDOR,
                ":d3": op_type,
                ":one": 1,
            },
        )
    except Exception:
        logger.warning(
            "Failed to record vector_db usage for customer=%s op_type=%s",
            customer_id, op_type, exc_info=True,
        )


# Web search credits (Tavily) have no real per-request vendor price exposed
# to us either — same read-time-pricing posture as vector_db, see above.
_WEB_SEARCH_VENDOR = "tavily"


def record_web_search_usage(customer_id: str, search_depth: str, credits: int) -> None:
    """
    Fans one web_search tool call into the CustomerAIUsage rollup. dim3 is
    the Tavily search_depth ("basic"/"advanced"), which doubles as the
    UsageRateCard rateKey genai-proxy-server's UsageSummaryService looks up
    at read time. Best-effort: never let a usage write failure break the
    search call it's instrumenting.
    """
    if not customer_id or not search_depth:
        return
    sort_key = f"{_today_iso()}#web_search#{_WEB_SEARCH_VENDOR}#{search_depth}"

    try:
        customer_api_usage_table.update_item(
            Key={'customerId': customer_id, 'usageDate': sort_key},
            UpdateExpression="SET #cat = :cat, #ven = :ven, #d3 = :d3 ADD creditCount :c, requestCount :one",
            ExpressionAttributeNames={"#cat": "category", "#ven": "vendor", "#d3": "dim3"},
            ExpressionAttributeValues={
                ":cat": "web_search",
                ":ven": _WEB_SEARCH_VENDOR,
                ":d3": search_depth,
                ":c": int(credits),
                ":one": 1,
            },
        )
    except Exception:
        logger.warning(
            "Failed to record web_search usage for customer=%s search_depth=%s",
            customer_id, search_depth, exc_info=True,
        )
