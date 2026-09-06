import logging
import os
import time
from typing import Optional

import boto3
from boto3.dynamodb.conditions import Key

from encoding_library.observability import count
from graph.state import RetrievalState

logger = logging.getLogger(__name__)

# CustomerMemory table: PK=customerId, SK=memoryId ("MEM#" prefix for memory
# items). Attributes: text, kind (CORE/EPISODIC), updatedAt.
_TABLE_NAME = "CustomerMemory"
_MEMORY_ITEM_PREFIX = "MEM#"

_DEFAULT_MAX_MEMORIES = 20
_CACHE_TTL_SECONDS = 60

_dynamodb = None

# customer_id -> (loaded_at_monotonic, core memory items sorted newest-first)
_memory_cache: dict[str, tuple[float, list[dict]]] = {}


def _get_dynamodb():
    global _dynamodb
    if _dynamodb is None:
        region = os.getenv("AWS_REGION", "us-east-1")
        _dynamodb = boto3.resource("dynamodb", region_name=region)
    return _dynamodb


def _load_core_memories(customer_id: str) -> list[dict]:
    table = _get_dynamodb().Table(_TABLE_NAME)
    items: list[dict] = []
    kwargs = {
        "KeyConditionExpression": Key("customerId").eq(customer_id)
        & Key("memoryId").begins_with(_MEMORY_ITEM_PREFIX),
    }
    while True:
        response = table.query(**kwargs)
        items.extend(response.get("Items", []))
        last_key = response.get("LastEvaluatedKey")
        if not last_key:
            break
        kwargs["ExclusiveStartKey"] = last_key
    core = [i for i in items if i.get("kind") == "CORE" and i.get("text")]
    core.sort(key=lambda i: i.get("updatedAt", ""), reverse=True)
    return core


def _get_cached_core_memories(customer_id: str) -> list[dict]:
    now = time.monotonic()
    cached = _memory_cache.get(customer_id)
    if cached and now - cached[0] < _CACHE_TTL_SECONDS:
        return cached[1]
    memories = _load_core_memories(customer_id)
    _memory_cache[customer_id] = (now, memories)
    return memories


def _render_block(memories: list[dict], max_memories: int) -> str:
    """Same block format the Kotlin layer used to inject, kept for continuity."""
    core = memories[:max_memories]
    if not core:
        return ""
    lines = [
        "## What you know about this user",
        "Learned from earlier conversations and notes; apply when relevant, "
        "never claim the user just told you:",
    ]
    lines.extend(f"- {m['text']}" for m in core)
    return "\n".join(lines)


def memory(node_id: Optional[str] = None):
    """
    Factory: the MEMORY primitive — no model call. Loads the customer's CORE
    memories and writes the rendered block to state:

      - memories_block: appended to the response node's persona (system prompt)
      - scratch["memories"]: usable as {memories} in any later node's templates

    Governance stays upstream: the node is inert unless the request carries
    memory_enabled=true (the proxy server's consent decision — the request's
    "use learned preferences" flag AND the account-level memory setting).

    Config (all optional): max_memories (default 20).
    """
    async def node(state: RetrievalState) -> dict:
        if not state.get("memory_enabled"):
            return {}
        configs = state.get("node_configs", {})
        config = (configs.get(node_id) if node_id else None) or configs.get("MEMORY", {})
        max_memories = int(config.get("max_memories") or _DEFAULT_MAX_MEMORIES)

        try:
            memories = _get_cached_core_memories(state["customer_id"])
        except Exception:
            # Memory must never break generation — but count the degradation:
            # without this, memory being silently down is invisible to alarms.
            count("memory_load_failure_total")
            logger.exception("Failed to load memories for %s; proceeding without", state["customer_id"])
            return {}

        block = _render_block(memories, max_memories)
        if not block:
            return {}
        logger.info(
            "Node memory: injecting %d memori(es) for customer=%s",
            min(len(memories), max_memories), state["customer_id"],
        )
        return {"memories_block": block, "scratch": {"memories": block}}

    node.__name__ = "memory"
    return node
