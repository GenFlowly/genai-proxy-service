"""
Unit tests for graph.nodes.memory — the MEMORY node (CORE injection +
per-message EPISODIC recall).

Run with `python -m unittest tests.test_memory_node`.

Pinned here:

  * consent gating: memory_enabled=false → inert, no data access at all
  * the CORE block format is unchanged (continuity with the Kotlin-era block)
  * EPISODIC recall joins vector hits back to DynamoDB by memory_key: shown-CORE
    duplicates and stale vectors (deleted memories) are dropped, the score
    floor gates, best-score-per-key dedup applies, and top_k caps the block
  * ranking blends a bounded recency boost into the cosine; the floor stays on
    the RAW cosine, and recall_recency_weight: 0 restores pure-cosine order
  * CORE past max_memories is demoted to recall-eligible — never silently lost
  * any recall failure degrades to the CORE-only block — never breaks the turn
  * recall_top_k: 0 (node config) disables recall entirely
  * the thinking-step payload distinguishes core vs recalled memories
"""
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

from graph.nodes import memory as memory_mod
from graph.nodes.memory import _is_memory_collection, _parse_timestamp, _recency_boost, memory
from streaming import _step_done_payload


def _mem(key: str, kind: str, text: str, updated: str = "2026-01-01T00:00:00Z") -> dict:
    return {"memoryId": key, "kind": kind, "text": text, "updatedAt": updated}


def _iso_days_ago(days: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _state(**overrides) -> dict:
    state = {
        "customer_id": "cust-1",
        "memory_enabled": True,
        "original_query": "how should I plan seed funding?",
        "node_configs": {},
        "model_type": None,
        "model_name": None,
    }
    state.update(overrides)
    return state


class _FakeMilvus:
    """Records search calls; returns the hits it was constructed with."""

    def __init__(self, hits: list[dict]):
        self._hits = hits
        self.search_calls: list[dict] = []

    def search(self, **kwargs):
        self.search_calls.append(kwargs)
        return [self._hits]


def _hit(key: str, score: float) -> dict:
    return {"id": key, "distance": score, "entity": {"memory_key": key}}


_COLLECTIONS = {("model-type", "model-name"): ["cust-1_memory_m"]}


class MemoryNodeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        memory_mod._memory_cache.clear()
        memory_mod._collection_cache.clear()

    async def _run(self, state, memories, hits=None, milvus_error=None):
        """Run the node with all external seams patched; returns (result, fake_client)."""
        client = _FakeMilvus(hits or [])
        milvus = MagicMock(return_value=client)
        if milvus_error:
            milvus = MagicMock(side_effect=milvus_error)
        with (
            patch.object(memory_mod, "_get_cached_memories", return_value=memories),
            patch.object(memory_mod, "_milvus_client", milvus),
            patch.object(memory_mod, "_memory_collections", return_value=_COLLECTIONS),
            patch.object(memory_mod, "_embed_query", return_value=[0.1, 0.2]),
        ):
            result = await memory("NODE1")(state)
        self._milvus = milvus
        return result, client

    async def test_disabled_is_inert(self):
        loader = MagicMock()
        with patch.object(memory_mod, "_get_cached_memories", loader):
            result = await memory("NODE1")(_state(memory_enabled=False))
        self.assertEqual(result, {})
        loader.assert_not_called()

    async def test_core_block_format_unchanged_and_no_recall_without_episodic(self):
        memories = [
            _mem("MEM#a", "CORE", "Works as an engineer.", "2026-01-02T00:00:00Z"),
            _mem("MEM#b", "CORE", "Is named Neel.", "2026-01-01T00:00:00Z"),
        ]
        result, _ = await self._run(_state(), memories)

        block = result["memories_block"]
        self.assertIn("## What you know about this user", block)
        # Newest first, exact bullet format
        self.assertLess(block.index("- Works as an engineer."), block.index("- Is named Neel."))
        self.assertNotIn("Possibly relevant", block)
        self.assertEqual(result["scratch"]["memory_stats"], {"core": 2, "recalled": 0})
        # No EPISODIC memories stored → the vector store is never touched
        self._milvus.assert_not_called()

    async def test_recall_joins_hits_back_to_ddb(self):
        memories = [
            _mem("MEM#core", "CORE", "Works as an engineer."),
            _mem("MEM#b", "EPISODIC", "Is considering quitting their job to start a business."),
            _mem("MEM#c", "EPISODIC", "Is building an AI agent platform."),
            _mem("MEM#d", "EPISODIC", "Their lawn is 600 square feet."),
        ]
        hits = [
            _hit("MEM#core", 0.95),  # CORE — already injected, dropped
            _hit("MEM#stale", 0.90),  # deleted memory, vector left behind — dropped
            _hit("MEM#b", 0.80),
            _hit("MEM#c", 0.50),  # exactly at the floor — kept
            _hit("MEM#d", 0.30),  # below the 0.5 floor — dropped
        ]
        result, client = await self._run(_state(), memories, hits=hits)

        block = result["memories_block"]
        self.assertIn("## Possibly relevant background for this message", block)
        self.assertIn("- Is considering quitting their job to start a business.", block)
        self.assertIn("- Is building an AI agent platform.", block)
        self.assertNotIn("600 square feet", block)
        # Best score first
        self.assertLess(block.index("quitting their job"), block.index("AI agent platform"))
        self.assertEqual(result["scratch"]["memory_stats"], {"core": 1, "recalled": 2})

        search = client.search_calls[0]
        self.assertEqual(search["collection_name"], "cust-1_memory_m")
        self.assertEqual(search["output_fields"], ["memory_key"])

    async def test_best_score_dedup_and_top_k_cap(self):
        memories = [_mem(f"MEM#{i}", "EPISODIC", f"Fact {i}.") for i in range(5)]
        hits = [
            _hit("MEM#0", 0.50),
            _hit("MEM#0", 0.90),  # same memory, better chunk — one entry, score 0.9
            _hit("MEM#1", 0.80),
            _hit("MEM#2", 0.70),
            _hit("MEM#3", 0.60),
            _hit("MEM#4", 0.55),  # fifth distinct hit — beyond default top_k=4
        ]
        result, _ = await self._run(_state(), memories, hits=hits)

        block = result["memories_block"]
        recalled = [line for line in block.splitlines() if line.startswith("- ")]
        self.assertEqual(recalled, ["- Fact 0.", "- Fact 1.", "- Fact 2.", "- Fact 3."])

    async def test_recency_breaks_ties_but_relevance_still_dominates(self):
        memories = [
            _mem("MEM#old-tie", "EPISODIC", "Old tie fact.", _iso_days_ago(365)),
            _mem("MEM#new-tie", "EPISODIC", "New tie fact.", _iso_days_ago(0)),
            _mem("MEM#old-strong", "EPISODIC", "Old strong fact.", _iso_days_ago(365)),
            _mem("MEM#new-weak", "EPISODIC", "New weak fact.", _iso_days_ago(0)),
        ]
        hits = [
            _hit("MEM#old-tie", 0.70),
            _hit("MEM#new-tie", 0.70),   # same cosine, a year fresher → ranks above
            _hit("MEM#old-strong", 0.92),  # max boost (+0.2) cannot overtake this
            _hit("MEM#new-weak", 0.60),
        ]
        result, _ = await self._run(_state(), memories, hits=hits)

        recalled = [l for l in result["memories_block"].splitlines() if l.startswith("- ")]
        self.assertEqual(
            recalled,
            # blended: 0.92+~0, 0.70+0.2, 0.60+0.2, 0.70+~0
            ["- Old strong fact.", "- New tie fact.", "- New weak fact.", "- Old tie fact."],
        )

    async def test_recency_weight_zero_restores_pure_cosine_ranking(self):
        memories = [
            _mem("MEM#old", "EPISODIC", "Old fact.", _iso_days_ago(365)),
            _mem("MEM#new", "EPISODIC", "New fact.", _iso_days_ago(0)),
        ]
        hits = [_hit("MEM#old", 0.70), _hit("MEM#new", 0.65)]
        state = _state(node_configs={"NODE1": {"recall_recency_weight": 0}})
        result, _ = await self._run(state, memories, hits=hits)

        recalled = [l for l in result["memories_block"].splitlines() if l.startswith("- ")]
        self.assertEqual(recalled, ["- Old fact.", "- New fact."])

    async def test_floor_gates_on_raw_cosine_not_the_boosted_score(self):
        memories = [_mem("MEM#fresh", "EPISODIC", "Fresh noise.", _iso_days_ago(0))]
        # 0.45 raw is under the 0.5 floor; the +0.2 recency boost must not rescue it
        result, _ = await self._run(_state(), memories, hits=[_hit("MEM#fresh", 0.45)])
        self.assertEqual(result, {})

    async def test_core_overflow_is_demoted_to_recall_not_dropped(self):
        memories = [
            _mem("MEM#new-core", "CORE", "Newest core fact.", _iso_days_ago(1)),
            _mem("MEM#old-core", "CORE", "Oldest core fact.", _iso_days_ago(300)),
        ]
        hits = [
            _hit("MEM#new-core", 0.95),  # injected above — still dropped from recall
            _hit("MEM#old-core", 0.90),  # over the cap — now recall-eligible
        ]
        state = _state(node_configs={"NODE1": {"max_memories": 1}})
        result, _ = await self._run(state, memories, hits=hits)

        block = result["memories_block"]
        core_section, recall_section = block.split("## Possibly relevant")
        self.assertIn("- Newest core fact.", core_section)
        self.assertNotIn("- Oldest core fact.", core_section)
        self.assertIn("- Oldest core fact.", recall_section)
        self.assertNotIn("- Newest core fact.", recall_section)
        self.assertEqual(
            result["scratch"]["memory_stats"],
            {"core": 1, "recalled": 1, "core_overflow": 1},
        )

    async def test_recall_failure_degrades_to_core_only(self):
        memories = [
            _mem("MEM#a", "CORE", "Works as an engineer."),
            _mem("MEM#b", "EPISODIC", "Is building an AI agent platform."),
        ]
        counted = []
        with patch.object(memory_mod, "count", lambda name, *a, **k: counted.append(name)):
            result, _ = await self._run(_state(), memories, milvus_error=RuntimeError("zilliz down"))

        block = result["memories_block"]
        self.assertIn("- Works as an engineer.", block)
        self.assertNotIn("Possibly relevant", block)
        self.assertIn("memory_recall_failure_total", counted)
        self.assertEqual(result["scratch"]["memory_stats"], {"core": 1, "recalled": 0})

    async def test_recall_top_k_zero_disables_recall(self):
        memories = [
            _mem("MEM#a", "CORE", "Works as an engineer."),
            _mem("MEM#b", "EPISODIC", "Is building an AI agent platform."),
        ]
        state = _state(node_configs={"NODE1": {"recall_top_k": 0}})
        result, _ = await self._run(state, memories, hits=[_hit("MEM#b", 0.9)])

        self.assertNotIn("Possibly relevant", result["memories_block"])
        self._milvus.assert_not_called()

    async def test_recall_without_core_still_injects(self):
        memories = [_mem("MEM#b", "EPISODIC", "Is building an AI agent platform.")]
        result, _ = await self._run(_state(), memories, hits=[_hit("MEM#b", 0.9)])

        block = result["memories_block"]
        self.assertNotIn("## What you know about this user", block)
        self.assertIn("## Possibly relevant background for this message", block)
        self.assertEqual(result["scratch"]["memory_stats"], {"core": 0, "recalled": 1})

    async def test_empty_query_skips_recall(self):
        memories = [
            _mem("MEM#a", "CORE", "Works as an engineer."),
            _mem("MEM#b", "EPISODIC", "Is building an AI agent platform."),
        ]
        result, _ = await self._run(_state(original_query="  "), memories, hits=[_hit("MEM#b", 0.9)])

        self.assertNotIn("Possibly relevant", result["memories_block"])
        self._milvus.assert_not_called()

    async def test_nothing_stored_returns_empty_update(self):
        result, _ = await self._run(_state(), [])
        self.assertEqual(result, {})


class MemoryCacheTests(unittest.TestCase):
    """The per-customer memory cache: TTL hits skip DDB, size stays bounded."""

    def setUp(self):
        memory_mod._memory_cache.clear()

    def test_memories_are_served_from_cache_within_the_ttl(self):
        loader = MagicMock(return_value=[_mem("MEM#a", "CORE", "Works as an engineer.")])
        with patch.object(memory_mod, "_load_memories", loader):
            first = memory_mod._get_cached_memories("cust-1")
            second = memory_mod._get_cached_memories("cust-1")
        self.assertEqual(first, second)
        loader.assert_called_once()

    def test_cache_never_grows_past_its_bound(self):
        with patch.object(memory_mod, "_load_memories", return_value=[]):
            for i in range(memory_mod._CACHE_MAX_SIZE + 50):
                memory_mod._get_cached_memories(f"cust-{i}")
        self.assertEqual(len(memory_mod._memory_cache), memory_mod._CACHE_MAX_SIZE)


class RecencyHelperTests(unittest.TestCase):
    def test_timestamp_parsing_tolerates_z_and_nanoseconds(self):
        # Real DDB rows carry both plain-seconds and 9-digit fractional forms
        self.assertIsNotNone(_parse_timestamp("2026-09-06T17:32:25Z"))
        self.assertIsNotNone(_parse_timestamp("2026-09-06T17:32:25.916654398Z"))
        self.assertIsNotNone(_parse_timestamp("2026-09-06T17:32:25.916654398+00:00"))
        self.assertIsNone(_parse_timestamp(None))
        self.assertIsNone(_parse_timestamp(""))
        self.assertIsNone(_parse_timestamp("not-a-date"))

    def test_boost_halves_per_half_life_and_unknown_age_counts_as_old(self):
        now = datetime(2026, 10, 20, tzinfo=timezone.utc)
        thirty_days_old = {"updatedAt": "2026-09-20T00:00:00Z"}
        self.assertAlmostEqual(_recency_boost(thirty_days_old, now, 30.0), 0.5, places=3)
        fresh = {"updatedAt": "2026-10-20T00:00:00Z"}
        self.assertAlmostEqual(_recency_boost(fresh, now, 30.0), 1.0, places=3)
        self.assertEqual(_recency_boost({}, now, 30.0), 0.0)
        # createdAt is the fallback when updatedAt is absent
        self.assertAlmostEqual(
            _recency_boost({"createdAt": "2026-09-20T00:00:00Z"}, now, 30.0), 0.5, places=3
        )


class MemoryCollectionFilterTests(unittest.TestCase):
    def test_matches_only_shared_memory_collections(self):
        self.assertTrue(_is_memory_collection("memory_voyage_4_large"))
        self.assertTrue(_is_memory_collection("memory"))
        self.assertFalse(_is_memory_collection("memorybank_x"))
        self.assertFalse(_is_memory_collection("notes_voyage_4_large"))
        # Legacy per-customer collections are no longer read paths; tenancy
        # lives in the shared collection's customer_id partition key.
        self.assertFalse(_is_memory_collection("cust-1_memory_voyage3"))
        self.assertFalse(_is_memory_collection("cust-1"))


class MemoryThinkingStepTests(unittest.TestCase):
    """The MEMORY branch of streaming._step_done_payload."""

    def test_distinguishes_core_and_recalled(self):
        block = (
            "## What you know about this user\nintro:\n- Core fact A.\n- Core fact B.\n\n"
            "## Possibly relevant background for this message\nintro:\n- Recalled fact."
        )
        payload = _step_done_payload(
            "MEMORY",
            {"memories_block": block, "scratch": {"memory_stats": {"core": 2, "recalled": 1}}},
        )
        self.assertEqual(
            payload["detail"],
            "Applied 2 core memori(es); recalled 1 related to this message",
        )
        # Labeled split for clients that render the two groups
        self.assertEqual(
            payload["memories"],
            {"core": ["Core fact A.", "Core fact B."], "recalled": ["Recalled fact."]},
        )
        # Back-compat flat list: recalled items lead — they are the per-message news
        self.assertEqual(payload["items"][0], "Recalled fact.")
        self.assertEqual(payload["items"][1:], ["Core fact A.", "Core fact B."])

    def test_nothing_is_capped_or_truncated(self):
        # Regression: 8 core + 1 recalled used to render as 5 bullets cut at
        # 120 chars — every memory must survive in full.
        long = "L" * 300
        core_lines = "\n".join(f"- Core fact {i}. {long}" for i in range(8))
        block = (
            f"## What you know about this user\nintro:\n{core_lines}\n\n"
            f"## Possibly relevant background for this message\nintro:\n- Recalled fact. {long}"
        )
        payload = _step_done_payload(
            "MEMORY",
            {"memories_block": block, "scratch": {"memory_stats": {"core": 8, "recalled": 1}}},
        )
        self.assertEqual(len(payload["items"]), 9)
        self.assertEqual(len(payload["memories"]["core"]), 8)
        self.assertEqual(payload["memories"]["recalled"], [f"Recalled fact. {long}"])
        self.assertTrue(all(len(m) > 120 for m in payload["items"]))

    def test_core_only_wording(self):
        block = "## What you know about this user\nintro:\n- Core fact A."
        payload = _step_done_payload(
            "MEMORY",
            {"memories_block": block, "scratch": {"memory_stats": {"core": 1, "recalled": 0}}},
        )
        self.assertEqual(payload["detail"], "Applied 1 core memori(es)")
        self.assertEqual(payload["items"], ["Core fact A."])

    def test_falls_back_to_line_count_without_stats(self):
        block = "## What you know about this user\nintro:\n- Core fact A."
        payload = _step_done_payload("MEMORY", {"memories_block": block})
        self.assertEqual(payload["detail"], "Applied 1 learned memori(es)")

    def test_empty_update_reads_as_no_memories(self):
        payload = _step_done_payload("MEMORY", {})
        self.assertEqual(payload["detail"], "No stored memories to apply")


if __name__ == "__main__":
    unittest.main()
