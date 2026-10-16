"""
Unit tests for graph.nodes.memory — the MEMORY node (CORE injection +
per-message EPISODIC recall).

Run with `python -m unittest tests.test_memory_node`.

Pinned here:

  * consent gating: memory_enabled=false → inert, no data access at all
  * the CORE block format is unchanged (continuity with the Kotlin-era block)
  * EPISODIC recall joins vector hits back to DynamoDB by memory_key: CORE
    duplicates and stale vectors (deleted memories) are dropped, the score
    floor gates, best-score-per-key dedup applies, and top_k caps the block
  * any recall failure degrades to the CORE-only block — never breaks the turn
  * recall_top_k: 0 (node config) disables recall entirely
  * the thinking-step payload distinguishes core vs recalled memories
"""
import unittest
from unittest.mock import MagicMock, patch

from graph.nodes import memory as memory_mod
from graph.nodes.memory import _is_memory_collection, memory
from streaming import _step_done_payload


def _mem(key: str, kind: str, text: str, updated: str = "2026-01-01T00:00:00Z") -> dict:
    return {"memoryId": key, "kind": kind, "text": text, "updatedAt": updated}


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
        # Recalled items lead — they are the per-message news
        self.assertEqual(payload["items"][0], "Recalled fact.")
        self.assertEqual(payload["items"][1:], ["Core fact A.", "Core fact B."])

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
