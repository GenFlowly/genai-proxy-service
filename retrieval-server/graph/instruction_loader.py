import logging
import os
import time
from typing import Optional

import boto3
from boto3.dynamodb.conditions import Key

logger = logging.getLogger(__name__)

# Instructions table: PK=instructionId, SK=version (Number). Rows are immutable
# once written — a pinned (id, version) can be cached forever. "Latest" is the
# highest version and changes on every edit, so it gets a short TTL.
_TABLE_NAME = "Instructions"
_CONTENT_KEY = "instructions"

_LATEST_TTL_SECONDS = 60

_dynamodb = None

# (instruction_id, version) -> content. Immutable, never expires.
_pinned_cache: dict[tuple[str, int], str] = {}
# instruction_id -> (loaded_at_monotonic, content or None)
_latest_cache: dict[str, tuple[float, Optional[str]]] = {}


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
    if cache_key in _pinned_cache:
        return _pinned_cache[cache_key]
    table = _get_dynamodb().Table(_TABLE_NAME)
    item = table.get_item(Key={"instructionId": instruction_id, "version": version}).get("Item")
    content = item.get(_CONTENT_KEY) if item else None
    if content is not None:
        _pinned_cache[cache_key] = content
    else:
        logger.warning("Instruction %s v%d not found", instruction_id, version)
    return content


def _get_latest(instruction_id: str) -> Optional[str]:
    now = time.monotonic()
    cached = _latest_cache.get(instruction_id)
    if cached and now - cached[0] < _LATEST_TTL_SECONDS:
        return cached[1]
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
    _latest_cache[instruction_id] = (now, content)
    return content


def invalidate_instruction_cache(instruction_id: Optional[str] = None) -> None:
    """Drop the latest-version cache (for one instruction, or all)."""
    if instruction_id is None:
        _latest_cache.clear()
    else:
        _latest_cache.pop(instruction_id, None)
