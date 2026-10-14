import logging
import os
import time
from typing import Optional

import boto3
from boto3.dynamodb.conditions import Key

from encoding_library.observability import count, observe
from graph.state import RetrievalState

logger = logging.getLogger(__name__)

# CustomerMemory table: PK=customerId, SK=memoryId ("MEM#" prefix for memory
# items). Attributes: text, kind (CORE/EPISODIC), updatedAt.
_TABLE_NAME = "CustomerMemory"
_MEMORY_ITEM_PREFIX = "MEM#"

_DEFAULT_MAX_MEMORIES = 20

# EPISODIC recall: how many semantically related memories one message may pull
# in, and the similarity floor a hit must clear. The floor sits below the
# knowledge-base default (0.6) on purpose: memories are single short sentences
# (systematically lower question↔fact similarity than long KB chunks), results
# are ranked with a small cap, and the block tells the model to judge
# applicability itself — so the floor is a noise gate, not a recall knob. It
# was chosen without measured score distributions; the memory_recall_score
# summary exists precisely so it can be tuned from real traffic. Both are
# per-node config (recall_top_k / recall_min_score); recall_top_k: 0 turns
# recall off.
_DEFAULT_RECALL_TOP_K = 4
_DEFAULT_RECALL_MIN_SCORE = 0.5
# Same Milvus search params the request schema defaults to (models.py).
_RECALL_SEARCH_PARAMS = {"metric_type": "COSINE", "params": {"nprobe": 10}}

_CACHE_TTL_SECONDS = 60

_dynamodb = None

# customer_id -> (loaded_at_monotonic, ALL memory items). CORE filtering and
# EPISODIC lookup both read from this one cached DDB query.
_memory_cache: dict[str, tuple[float, list[dict]]] = {}

# customer_id -> (loaded_at_monotonic, {(model_type, model_name): [collection]}).
# Listing/describing collections costs Zilliz round-trips on a node that runs
# every turn; memory collections only change when a customer's first memory is
# encoded, so short staleness is harmless.
_collection_cache: dict[str, tuple[float, dict]] = {}


def _get_dynamodb():
    global _dynamodb
    if _dynamodb is None:
        region = os.getenv("AWS_REGION", "us-east-1")
        _dynamodb = boto3.resource("dynamodb", region_name=region)
    return _dynamodb


def _load_memories(customer_id: str) -> list[dict]:
    """Every stored memory (all kinds) for the customer."""
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
    return items


def _get_cached_memories(customer_id: str) -> list[dict]:
    now = time.monotonic()
    cached = _memory_cache.get(customer_id)
    if cached and now - cached[0] < _CACHE_TTL_SECONDS:
        return cached[1]
    memories = _load_memories(customer_id)
    _memory_cache[customer_id] = (now, memories)
    return memories


# ── EPISODIC recall (vector search over the customer's memory collections) ──
#
# The write side has always embedded every memory into
# '{customer_id}_memory_{model}' (MemoryExtractionService.encodeMemoryVector);
# this is the read side: embed the current message, search those collections,
# and join hits back to DynamoDB by memory_key. DDB stays the source of truth —
# a hit whose key is no longer stored (deleted memory, stale vector) or is CORE
# (already injected unconditionally) is dropped.


def _milvus_client(customer_id: str):
    # Lazy import: pymilvus must not be a price of importing this module.
    from encoding_library.utils.vector_db import get_milvus_client

    return get_milvus_client(customer_id)


def _embed_query(query: str, model_type: Optional[str], model_name: Optional[str]) -> Optional[list]:
    # Lazy import: the embedding stack loads models into process memory.
    from encoding_library.utils.embedding_utils import create_embeddings
    from graph.nodes.retrieval import _get_cached_embedding_model

    encoder = _get_cached_embedding_model(model_type, model_name)
    embeddings = create_embeddings([query], encoder)
    if not embeddings:
        return None
    return embeddings[0].get("vector")


def _is_memory_collection(name: str, customer_id: str) -> bool:
    prefix = f"{customer_id}_"
    if not name.startswith(prefix):
        return False
    return name[len(prefix):].split("_")[0] == "memory"


def _memory_collections(client, customer_id: str, fallback_model: tuple) -> dict:
    """The customer's memory collections grouped by embedding model, read from
    the collection-description metadata (same convention as the retrieval
    node); cached per customer. The request-supplied fallback model only
    applies to legacy collections without metadata, so caching across requests
    is safe in practice."""
    now = time.monotonic()
    cached = _collection_cache.get(customer_id)
    if cached and now - cached[0] < _CACHE_TTL_SECONDS:
        return cached[1]

    from encoding_library.utils.model_registry import parse_collection_description, resolve_model

    grouped: dict = {}
    for name in client.list_collections():
        if not _is_memory_collection(name, customer_id):
            continue
        model = resolve_model(*fallback_model)
        try:
            meta = parse_collection_description(client.describe_collection(name).get("description"))
            if meta:
                model = resolve_model(meta.get("model_type"), meta.get("model_name"))
        except Exception as e:
            logger.warning("Could not read metadata for collection '%s': %s", name, e)
        grouped.setdefault(model, []).append(name)
    _collection_cache[customer_id] = (now, grouped)
    return grouped


def _recall_episodic(
    state: RetrievalState,
    episodic_by_key: dict[str, dict],
    top_k: int,
    min_score: float,
) -> list[dict]:
    """EPISODIC memories related to the current message, best-score first:
    [{"memory": <ddb item>, "score": float}], at most top_k."""
    query = (state.get("original_query") or "").strip()
    if not query:
        return []
    customer_id = state["customer_id"]

    client = _milvus_client(customer_id)
    grouped = _memory_collections(
        client, customer_id, (state.get("model_type"), state.get("model_name"))
    )
    if not grouped:
        return []

    best_score: dict[str, float] = {}
    for (model_type, model_name), collection_names in grouped.items():
        vector = _embed_query(query, model_type, model_name)
        if vector is None:
            count("embedding_failure_total", source="memory_recall", model=model_name or "")
            logger.error(
                "Node memory: query embedding failed for model %s/%s", model_type, model_name
            )
            continue
        for collection_name in collection_names:
            search_res = client.search(
                collection_name=collection_name,
                data=[vector],
                # Over-fetch: CORE hits (already injected) and stale vectors
                # are dropped after the search, so the floor must survive that.
                limit=max(top_k * 2, 8),
                search_params=_RECALL_SEARCH_PARAMS,
                output_fields=["memory_key"],
            )
            for hits in search_res:
                for hit in hits:
                    score = hit.get("distance", 0.0)
                    key = (hit.get("entity") or {}).get("memory_key")
                    if not key or key not in episodic_by_key:
                        continue
                    # Observed BEFORE the floor so the score distribution in
                    # Grafana shows what the current floor cuts — the data for
                    # tuning recall_min_score.
                    observe("memory_recall_score", score)
                    if score < min_score:
                        continue
                    if score > best_score.get(key, -1.0):
                        best_score[key] = score

    ranked = sorted(best_score.items(), key=lambda kv: kv[1], reverse=True)[:top_k]
    return [{"memory": episodic_by_key[key], "score": score} for key, score in ranked]


def _render_block(core: list[dict], max_memories: int, recalled: list[dict]) -> str:
    """CORE section in the exact block format the Kotlin layer used to inject
    (kept for continuity), followed by the per-message EPISODIC recall section."""
    sections = []
    shown = core[:max_memories]
    if shown:
        lines = [
            "## What you know about this user",
            "Learned from earlier conversations and notes; apply when relevant, "
            "never claim the user just told you:",
        ]
        lines.extend(f"- {m['text']}" for m in shown)
        sections.append("\n".join(lines))
    if recalled:
        lines = [
            "## Possibly relevant background for this message",
            "Recalled from what you learned earlier because it looks related to "
            "the current message. It may be stale or off-topic — use only what "
            "actually applies, and never claim the user just told you:",
        ]
        lines.extend(f"- {r['memory']['text']}" for r in recalled)
        sections.append("\n".join(lines))
    return "\n\n".join(sections)


def memory(node_id: Optional[str] = None):
    """
    Factory: the MEMORY primitive — no model call. Loads what is known about
    the customer and writes the rendered block to state:

      - memories_block: appended to the response node's persona (system prompt)
      - scratch["memories"]: usable as {memories} in any later node's templates
      - scratch["memory_stats"]: {"core": n, "recalled": n} for the thinking step

    Two halves:
      - CORE memories (compact, always-relevant) are injected on every turn,
        newest first, capped at max_memories.
      - EPISODIC memories are recalled per message: the current query is
        embedded and searched against the customer's memory vector collections;
        the top recall_top_k hits at or above recall_min_score are injected
        under a "possibly relevant" header. Recall is best-effort — any failure
        degrades to the CORE-only block, never breaks generation.

    Governance stays upstream: the node is inert unless the request carries
    memory_enabled=true (the proxy server's consent decision — the request's
    "use learned preferences" flag AND the account-level memory setting).

    Config (all optional): max_memories (default 20), recall_top_k (default 4,
    0 disables recall), recall_min_score (default 0.5).
    """
    async def node(state: RetrievalState) -> dict:
        if not state.get("memory_enabled"):
            return {}
        configs = state.get("node_configs", {})
        config = (configs.get(node_id) if node_id else None) or configs.get("MEMORY", {})
        max_memories = int(config.get("max_memories") or _DEFAULT_MAX_MEMORIES)
        raw_top_k = config.get("recall_top_k")
        recall_top_k = _DEFAULT_RECALL_TOP_K if raw_top_k is None else max(0, int(raw_top_k))
        raw_min_score = config.get("recall_min_score")
        recall_min_score = (
            _DEFAULT_RECALL_MIN_SCORE if raw_min_score is None else float(raw_min_score)
        )

        try:
            memories = _get_cached_memories(state["customer_id"])
        except Exception:
            # Memory must never break generation — but count the degradation:
            # without this, memory being silently down is invisible to alarms.
            count("memory_load_failure_total")
            logger.exception("Failed to load memories for %s; proceeding without", state["customer_id"])
            return {}

        core = [i for i in memories if i.get("kind") == "CORE" and i.get("text")]
        core.sort(key=lambda i: i.get("updatedAt", ""), reverse=True)
        episodic_by_key = {
            i["memoryId"]: i
            for i in memories
            if i.get("kind") != "CORE" and i.get("text") and i.get("memoryId")
        }

        recalled: list[dict] = []
        if recall_top_k > 0 and episodic_by_key:
            try:
                recalled = _recall_episodic(state, episodic_by_key, recall_top_k, recall_min_score)
            except Exception:
                count("memory_recall_failure_total", source="node")
                logger.exception(
                    "EPISODIC recall failed for %s; continuing with CORE only",
                    state["customer_id"],
                )

        block = _render_block(core, max_memories, recalled)
        if not block:
            # Logged so "ran but had nothing to inject" is distinguishable from
            # the node not running at all (e.g. on the non-streaming path,
            # which has no per-node START/END logging).
            logger.info(
                "Node memory: nothing to inject for customer=%s — %d CORE memori(es) loaded, max_memories=%d",
                state["customer_id"], len(core), max_memories,
            )
            return {}
        logger.info(
            "Node memory: injecting %d core + %d recalled memori(es) for customer=%s",
            min(len(core), max_memories), len(recalled), state["customer_id"],
        )
        return {
            "memories_block": block,
            "scratch": {
                "memories": block,
                "memory_stats": {
                    "core": min(len(core), max_memories),
                    "recalled": len(recalled),
                },
            },
        }

    node.__name__ = "memory"
    return node
