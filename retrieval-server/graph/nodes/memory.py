import asyncio
import logging
import os
import re
from datetime import datetime, timezone
from typing import Optional

import boto3
from boto3.dynamodb.conditions import Key

from encoding_library.observability import count, observe
from graph.bounded_cache import BoundedCache
from graph.state import RetrievalState

logger = logging.getLogger(__name__)

# CustomerMemory table: PK=customerId, SK=memoryId ("MEM#" prefix for memory
# items). Attributes: text, kind (CORE/EPISODIC), placements, updatedAt.
# placements maps "PROFILE" or a project id to the memory's kind there; rows
# written before placements existed have none and apply in Profile with
# their kind.
_TABLE_NAME = "CustomerMemory"
_MEMORY_ITEM_PREFIX = "MEM#"
_PROFILE_PLACEMENT = "PROFILE"
# Usage-log rows, one per memory and reply: "MEMUSE#<uuid>#<turnStartedAt>#
# <responseMessageId>" (the proxy reads them with the same key format).
_MEMORY_USAGE_PREFIX = "MEMUSE#"

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

# EPISODIC ranking blends recency into the cosine score (generative-agents
# style additive boost): ranking = cosine + weight * 0.5**(age_days/half_life).
# The boost is bounded by `weight`, so it breaks ties and near-ties toward
# fresh memories while a clearly more relevant old memory still outranks a
# vaguely relevant new one. The recall_min_score floor stays on the RAW
# cosine — recency never rescues a semantic-noise hit — and the
# memory_recall_score summary keeps observing raw scores so the floor stays
# tunable. Both per-node config (recall_recency_weight / recall_half_life_days);
# recall_recency_weight: 0 restores pure-cosine ranking.
_DEFAULT_RECALL_RECENCY_WEIGHT = 0.2
_DEFAULT_RECALL_HALF_LIFE_DAYS = 30.0

_CACHE_TTL_SECONDS = 60
_CACHE_MAX_SIZE = 256

_dynamodb = None

# customer_id -> ALL memory items. CORE filtering and EPISODIC lookup both
# read from this one cached DDB query.
_memory_cache = BoundedCache(_CACHE_MAX_SIZE, ttl_seconds=_CACHE_TTL_SECONDS)

# customer_id -> {(model_type, model_name): [collection]}. Listing/describing
# collections costs Zilliz round-trips on a node that runs every turn; memory
# collections only change when a customer's first memory is encoded, so short
# staleness is harmless.
_collection_cache = BoundedCache(_CACHE_MAX_SIZE, ttl_seconds=_CACHE_TTL_SECONDS)


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
    cached = _memory_cache.get(customer_id)
    if cached is not None:
        return cached
    memories = _load_memories(customer_id)
    _memory_cache.set(customer_id, memories)
    return memories


def kind_here(item: dict, project_id: Optional[str]) -> Optional[str]:
    """The memory's kind in this conversation: its Profile kind, else its kind
    in the conversation's project, else None — it doesn't apply here, and a
    project's memories stay inside that project."""
    placements = item.get("placements")
    if not placements:
        return item.get("kind")
    if _PROFILE_PLACEMENT in placements:
        return placements[_PROFILE_PLACEMENT]
    if project_id and project_id in placements:
        return placements[project_id]
    return None


def _write_usage(customer_id: str, memory_context: dict, used: list[tuple[str, str]], source: str) -> None:
    """One usage row per memory plus its hit counter, in one transaction each.
    The row's key names the reply, so a retried or failed-over call for the
    same reply is refused by the condition instead of counting twice."""
    # The resource's client serializes plain Python values itself; typed
    # {"S": ...} values would be stored (and ADDed) as maps.
    client = _get_dynamodb().meta.client
    turn = memory_context["turn_started_at"]
    message_id = memory_context["response_message_id"]
    recorded = 0
    for memory_id, how in used:
        usage_item = {
            "customerId": customer_id,
            "memoryId": f"{_MEMORY_USAGE_PREFIX}{memory_id[len(_MEMORY_ITEM_PREFIX):]}#{turn}#{message_id}",
            "conversationId": memory_context["conversation_id"],
            "messageId": message_id,
            "usedAt": turn,
            "how": how,
        }
        if memory_context.get("project_id"):
            usage_item["projectId"] = memory_context["project_id"]
        try:
            client.transact_write_items(TransactItems=[
                {"Put": {
                    "TableName": _TABLE_NAME,
                    "Item": usage_item,
                    "ConditionExpression": "attribute_not_exists(memoryId)",
                }},
                {"Update": {
                    "TableName": _TABLE_NAME,
                    "Key": {"customerId": customer_id, "memoryId": memory_id},
                    "UpdateExpression": "ADD hitCount :one SET lastUsedAt = :at",
                    "ConditionExpression": "attribute_exists(memoryId)",
                    "ExpressionAttributeValues": {":one": 1, ":at": turn},
                }},
            ])
            recorded += 1
        except Exception as e:
            code = getattr(e, "response", {}).get("Error", {}).get("Code")
            if code == "TransactionCanceledException":
                # Already counted for this reply, or the memory was deleted.
                continue
            count("memory_usage_write_failure_total", source=source)
            logger.warning("Could not record usage of memory %s for %s: %s", memory_id, customer_id, e)
    if recorded:
        count("memory_usage_recorded_total", recorded, source=source)


def record_usage(
    memory_context: Optional[dict], customer_id: str, used: list[tuple[str, str]], source: str
) -> None:
    """Logs that [used] memories (memoryId, "core" | "recalled" | "search")
    were sent to the model for this reply, off the event loop and without
    waiting: usage logging must never slow down or break generation. A
    request without a memory context (internal calls, voice, evals) logs
    nothing."""
    if not used or not memory_context:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        _write_usage(customer_id, memory_context, used, source)
        return
    loop.run_in_executor(None, _write_usage, customer_id, memory_context, list(used), source)


# ── EPISODIC recall (vector search over the shared memory collections) ──
#
# The write side embeds every memory into the shared 'memory_{model}'
# collection, stamped with the customer_id partition key (/encode-memory);
# this is the read side: embed the current message, search those collections
# customer-scoped, and join hits back to DynamoDB by memory_key. DDB stays the
# source of truth — a hit whose key is no longer stored (deleted memory, stale
# vector) or is a CORE memory already injected above is dropped. CORE beyond
# the max_memories cap is NOT injected, so it stays recall-eligible here
# instead of silently disappearing.


def _milvus_client(customer_id: str):
    # Lazy import: pymilvus must not be a price of importing this module.
    from encoding_library.utils.vector_db import get_milvus_client

    return get_milvus_client(customer_id)


def _embed_query(
    customer_id: str, query: str, model_type: Optional[str], model_name: Optional[str]
) -> Optional[list]:
    # Lazy import: the embedding stack loads models into process memory.
    from encoding_library.utils.embedding_utils import create_embeddings
    from graph.nodes.retrieval import customer_embedding_model

    encoder = customer_embedding_model(customer_id, model_type, model_name)
    embeddings = create_embeddings([query], encoder, customer_id=customer_id)
    if not embeddings:
        return None
    return embeddings[0].get("vector")


def _is_memory_collection(name: str) -> bool:
    # Lazy import: pymilvus/boto3-adjacent modules must not be a price of
    # importing this module.
    from encoding_library.utils.vector_db import collection_data_type

    return collection_data_type(name) == "memory"


def _memory_collections(client, customer_id: str, fallback_model: tuple) -> dict:
    """The shared memory collections grouped by embedding model, read from the
    collection-description metadata (same convention as the retrieval node);
    cached per customer (the Milvus client — and so the visible collections —
    is resolved per customer). Searches against these collections must be
    customer-scoped. The request-supplied fallback model only applies to
    collections without metadata, so caching across requests is safe in
    practice."""
    cached = _collection_cache.get(customer_id)
    if cached is not None:
        return cached

    from encoding_library.utils.model_registry import parse_collection_description, resolve_model

    grouped: dict = {}
    for name in client.list_collections():
        if not _is_memory_collection(name):
            continue
        model = resolve_model(*fallback_model)
        try:
            meta = parse_collection_description(client.describe_collection(name).get("description"))
            if meta:
                model = resolve_model(meta.get("model_type"), meta.get("model_name"))
        except Exception as e:
            logger.warning("Could not read metadata for collection '%s': %s", name, e)
        grouped.setdefault(model, []).append(name)
    _collection_cache.set(customer_id, grouped)
    return grouped


def _parse_timestamp(value) -> Optional[datetime]:
    """Aware datetime from the DDB ISO-8601 strings, or None. Tolerates the
    'Z' suffix and nanosecond precision (some rows carry 9 fractional digits;
    fromisoformat caps at 6)."""
    if not value or not isinstance(value, str):
        return None
    text = value.strip().replace("Z", "+00:00")
    text = re.sub(r"(\.\d{6})\d+", r"\1", text)
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _recency_boost(item: dict, now: datetime, half_life_days: float) -> float:
    """0..1 freshness factor: 1.0 for a just-updated memory, halving every
    half_life_days. Missing/unparseable timestamps count as old (0.0)."""
    ts = _parse_timestamp(item.get("updatedAt") or item.get("createdAt"))
    if ts is None:
        return 0.0
    age_days = max(0.0, (now - ts).total_seconds() / 86400.0)
    return 0.5 ** (age_days / half_life_days)


def _recall_episodic(
    state: RetrievalState,
    recallable_by_key: dict[str, dict],
    top_k: int,
    min_score: float,
    recency_weight: float,
    half_life_days: float,
) -> list[dict]:
    """Stored memories related to the current message, best ranking first:
    [{"memory": <ddb item>, "score": float}], at most top_k. Ranking blends
    the raw cosine with a bounded recency boost; "score" stays the raw cosine
    (it is what the floor gated and what the metric observed)."""
    query = (state.get("original_query") or "").strip()
    if not query:
        return []
    customer_id = state["customer_id"]

    # Lazy import, same reason as _milvus_client.
    from encoding_library.utils.vector_db import customer_filter

    client = _milvus_client(customer_id)
    grouped = _memory_collections(
        client, customer_id, (state.get("model_type"), state.get("model_name"))
    )
    if not grouped:
        return []

    best_score: dict[str, float] = {}
    for (model_type, model_name), collection_names in grouped.items():
        vector = _embed_query(customer_id, query, model_type, model_name)
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
                # Shared collection: scope to this customer's rows.
                filter=customer_filter(customer_id),
                # Over-fetch: shown-CORE hits (already injected), stale
                # vectors and other projects' memories are dropped after the
                # search, so the floor must survive that.
                limit=max(top_k * 4, 16),
                search_params=_RECALL_SEARCH_PARAMS,
                output_fields=["memory_key"],
            )
            for hits in search_res:
                for hit in hits:
                    score = hit.get("distance", 0.0)
                    key = (hit.get("entity") or {}).get("memory_key")
                    if not key or key not in recallable_by_key:
                        continue
                    # Observed BEFORE the floor so the score distribution in
                    # Grafana shows what the current floor cuts — the data for
                    # tuning recall_min_score.
                    observe("memory_recall_score", score)
                    if score < min_score:
                        continue
                    if score > best_score.get(key, -1.0):
                        best_score[key] = score

    now = datetime.now(timezone.utc)
    use_recency = recency_weight > 0 and half_life_days > 0

    def _ranking(kv: tuple[str, float]) -> float:
        key, raw = kv
        if not use_recency:
            return raw
        return raw + recency_weight * _recency_boost(recallable_by_key[key], now, half_life_days)

    ranked = sorted(best_score.items(), key=_ranking, reverse=True)[:top_k]
    return [{"memory": recallable_by_key[key], "score": score} for key, score in ranked]


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
        newest first, capped at max_memories. CORE beyond the cap is demoted
        to recall-eligible (below) rather than silently dropped, and surfaces
        on core_memory_overflow_total — overflow means extraction is minting
        more "always-relevant" facts than every turn can carry, which is a
        curation problem to fix at the source.
      - EPISODIC memories (plus overflow CORE) are recalled per message: the
        current query is embedded and searched against the customer's memory
        vector collections; hits at or above recall_min_score (raw cosine) are
        ranked by cosine + a bounded recency boost and the top recall_top_k
        are injected under a "possibly relevant" header. Recall is
        best-effort — any failure degrades to the CORE-only block, never
        breaks generation.

    Governance stays upstream: the node is inert unless the request carries
    memory_enabled=true (the proxy server's consent decision — the request's
    "use learned preferences" flag AND the account-level memory setting).

    Scope: only Profile memories and the conversation's project's (from
    memory_context) apply, each with its kind there. Every memory injected or
    recalled is logged once per reply in the memory's usage log, with its hit
    counter, in the background.

    Config (all optional): max_memories (default 20), recall_top_k (default 4,
    0 disables recall), recall_min_score (default 0.5), recall_recency_weight
    (default 0.2, 0 restores pure-cosine ranking), recall_half_life_days
    (default 30).
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
        raw_recency_weight = config.get("recall_recency_weight")
        recall_recency_weight = (
            _DEFAULT_RECALL_RECENCY_WEIGHT
            if raw_recency_weight is None
            else max(0.0, float(raw_recency_weight))
        )
        raw_half_life = config.get("recall_half_life_days")
        recall_half_life_days = (
            _DEFAULT_RECALL_HALF_LIFE_DAYS if raw_half_life is None else float(raw_half_life)
        )

        try:
            memories = _get_cached_memories(state["customer_id"])
        except Exception:
            # Memory must never break generation — but count the degradation:
            # without this, memory being silently down is invisible to alarms.
            count("memory_load_failure_total")
            logger.exception("Failed to load memories for %s; proceeding without", state["customer_id"])
            return {}

        # Profile memories plus the conversation's project's, each with its
        # kind here; other projects' memories never reach this conversation.
        project_id = (state.get("memory_context") or {}).get("project_id")
        here = [(i, kind) for i in memories if i.get("text") and (kind := kind_here(i, project_id))]
        core = [i for i, kind in here if kind == "CORE"]
        core.sort(key=lambda i: i.get("updatedAt", ""), reverse=True)
        overflow_core = [i for i in core[max_memories:] if i.get("memoryId")]
        if overflow_core:
            # Past the cap, CORE stops being "always injected". Don't let it
            # silently vanish: make the overflow visible to alarms and demote
            # it to recall-eligible so an old-but-relevant fact can still
            # surface for the messages it matters to.
            count("core_memory_overflow_total")
            logger.warning(
                "CORE memories over max_memories for %s: %d stored, %d injected, %d demoted to recall",
                state["customer_id"], len(core), max_memories, len(overflow_core),
            )
        recallable_by_key = {
            i["memoryId"]: i
            for i, kind in here
            if kind != "CORE" and i.get("memoryId")
        }
        recallable_by_key.update({i["memoryId"]: i for i in overflow_core})

        recalled: list[dict] = []
        if recall_top_k > 0 and recallable_by_key:
            try:
                recalled = _recall_episodic(
                    state,
                    recallable_by_key,
                    recall_top_k,
                    recall_min_score,
                    recall_recency_weight,
                    recall_half_life_days,
                )
            except Exception:
                count("memory_recall_failure_total", source="node")
                logger.exception(
                    "EPISODIC recall failed for %s; continuing with CORE only",
                    state["customer_id"],
                )

        used = [(i["memoryId"], "core") for i in core[:max_memories] if i.get("memoryId")]
        used += [(r["memory"]["memoryId"], "recalled") for r in recalled]
        record_usage(state.get("memory_context"), state["customer_id"], used, "node")

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
        memory_stats = {
            "core": min(len(core), max_memories),
            "recalled": len(recalled),
        }
        if overflow_core:
            memory_stats["core_overflow"] = len(overflow_core)
        return {
            "memories_block": block,
            "scratch": {
                "memories": block,
                "memory_stats": memory_stats,
            },
        }

    node.__name__ = "memory"
    return node
