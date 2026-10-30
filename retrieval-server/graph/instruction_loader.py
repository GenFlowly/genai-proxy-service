import logging
import os
from typing import Optional

import boto3
from boto3.dynamodb.conditions import Key

from graph.bounded_cache import BoundedCache

logger = logging.getLogger(__name__)

# Instructions table: PK=instructionId, SK=version (Number). Rows are immutable
# once written — a pinned (id, version) never goes stale, so that cache has no
# TTL, only an LRU bound. "Latest" is the highest version and changes on every
# edit, so it gets a short TTL.
_TABLE_NAME = "Instructions"
_CONTENT_KEY = "instructions"

_LATEST_TTL_SECONDS = 60
_PINNED_CACHE_MAX_SIZE = 512
_LATEST_CACHE_MAX_SIZE = 256

_dynamodb = None

# Distinguishes a cached "instruction has no content" (None) from a cache miss.
_MISSING = object()

# (instruction_id, version) -> content.
_pinned_cache = BoundedCache(_PINNED_CACHE_MAX_SIZE)
# instruction_id -> content or None (missing instructions are negative-cached
# for the TTL so a broken reference doesn't query DDB on every turn).
_latest_cache = BoundedCache(_LATEST_CACHE_MAX_SIZE, ttl_seconds=_LATEST_TTL_SECONDS)


def _get_dynamodb():
    global _dynamodb
    if _dynamodb is None:
        region = os.getenv("AWS_REGION", "us-east-1")
        _dynamodb = boto3.resource("dynamodb", region_name=region)
    return _dynamodb


def get_instruction_text(instruction_id: str, version: Optional[int] = None) -> Optional[str]:
    """
    Resolve an instruction reference to its prompt text.

    version=None follows the latest version (short-TTL cached); an int is a
    pinned, immutable version (cached forever). Returns None when the
    instruction cannot be resolved — callers fall back to the node's inline
    system_prompt or a hardcoded default.
    """
    if not instruction_id:
        return None
    try:
        if version is not None:
            return _get_pinned(instruction_id, int(version))
        return _get_latest(instruction_id)
    except Exception:
        logger.exception("Failed to resolve instruction %s v%s", instruction_id, version)
        return None


def _get_pinned(instruction_id: str, version: int) -> Optional[str]:
    cache_key = (instruction_id, version)
    cached = _pinned_cache.get(cache_key)
    if cached is not None:
        return cached
    table = _get_dynamodb().Table(_TABLE_NAME)
    item = table.get_item(Key={"instructionId": instruction_id, "version": version}).get("Item")
    content = item.get(_CONTENT_KEY) if item else None
    if content is not None:
        _pinned_cache.set(cache_key, content)
    else:
        logger.warning("Instruction %s v%d not found", instruction_id, version)
    return content


def _get_latest(instruction_id: str) -> Optional[str]:
    cached = _latest_cache.get(instruction_id, _MISSING)
    if cached is not _MISSING:
        return cached
    table = _get_dynamodb().Table(_TABLE_NAME)
    response = table.query(
        KeyConditionExpression=Key("instructionId").eq(instruction_id),
        ScanIndexForward=False,
        Limit=1,
    )
    items = response.get("Items", [])
    content = items[0].get(_CONTENT_KEY) if items else None
    if content is None:
        logger.warning("Instruction %s has no versions", instruction_id)
    _latest_cache.set(instruction_id, content)
    return content


def invalidate_instruction_cache(instruction_id: Optional[str] = None) -> None:
    """Drop the latest-version cache (for one instruction, or all)."""
    if instruction_id is None:
        _latest_cache.clear()
    else:
        _latest_cache.pop(instruction_id, None)
