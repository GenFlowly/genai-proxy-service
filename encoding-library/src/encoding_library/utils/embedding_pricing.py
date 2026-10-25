import os
import time
import logging
from typing import Optional, Tuple

import boto3

logger = logging.getLogger(__name__)

region_name = os.environ.get('AWS_REGION', 'us-east-1')
dynamodb = boto3.resource('dynamodb', region_name=region_name)

AI_MODEL_CATALOG_TABLE_NAME = os.environ.get('AI_MODEL_CATALOG_TABLE', 'AIModelCatalog')
ai_model_catalog_table = dynamodb.Table(AI_MODEL_CATALOG_TABLE_NAME)

_CACHE_TTL_SECONDS = 60 * 60
_cache: dict[Tuple[str, str], Tuple[Optional[float], float]] = {}


def get_embedding_cost_per_mtok(vendor: str, model: str) -> Optional[float]:
    """
    USD per 1M tokens for an embedding model, read from the AIModelCatalog
    table (PK=aiVendor, SK=model — the same table/pattern genai-proxy-server's
    ModelCatalogService uses for LLM pricing, synced from the LiteLLM price
    map). vendor must be the EmbeddingVendor name ("VOYAGE"/"OPENAI"), not a
    lowercase provider string — that's the key genai-proxy-server writes rows
    under. Returns None (never a guess) when the catalog has no price for the
    model, e.g. before the first daily sync. Cached in-process for
    [_CACHE_TTL_SECONDS] to avoid a DynamoDB round trip per embed call.
    """
    key = (vendor, model)
    cached = _cache.get(key)
    now = time.time()
    if cached is not None and now - cached[1] < _CACHE_TTL_SECONDS:
        return cached[0]

    try:
        response = ai_model_catalog_table.get_item(Key={'aiVendor': vendor, 'model': model})
        item = response.get('Item')
        rate = float(item['inputCostPerMTok']) if item and item.get('inputCostPerMTok') is not None else None
    except Exception:
        logger.warning("Failed to look up embedding price for %s/%s", vendor, model, exc_info=True)
        # Don't poison the cache with a transient DynamoDB failure — serve the
        # previous value (even if stale/None) rather than caching a false None.
        return cached[0] if cached is not None else None

    _cache[key] = (rate, now)
    return rate
