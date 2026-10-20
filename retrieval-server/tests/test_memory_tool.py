"""
Unit tests for graph.memory_tool — the search_memories built-in — and the
consent gates around it.

Run with `python -m unittest tests.test_memory_tool`.

Pinned here:

  * consent, both layers: the run-time refusal (context.runtime flag, covering
    subagents) touches no data; the bind-time gate (_build_state) drops the
    tool from builtin_tools unless the request carries memory_enabled
  * it searches with the CALLER's customer_id (tenant isolation from context)
  * hits join back to DynamoDB by memory_key: stale vectors (deleted memories)
    drop out, CORE and EPISODIC both surface, best-score dedup and top_k apply
  * results render with kind/category/updated-date/similarity context
  * every failure path degrades to a message the model can act on — the tool
    never raises out of run()
  * the RETRIEVAL/knowledge discovery no longer surfaces memory collections
"""
import unittest
from unittest.mock import MagicMock, patch

from graph.nodes import memory as memory_mod
from graph.memory_tool import SearchMemoriesTool
from graph.tools_runtime import MEMORY_CONSENT_TOOLS, all_builtin_tool_names, get_registry
from graph_tools.base import ToolContext


def _context(memory_enabled=True) -> ToolContext:
    context = ToolContext(customer_id="cust-1", store=None)
    if memory_enabled is not None:
        context.runtime["memory_enabled"] = memory_enabled
    return context


def _mem(key: str, kind: str, text: str, category: str = "", updated: str = "2026-10-01T12:00:00Z") -> dict:
    item = {"memoryId": key, "kind": kind, "text": text, "updatedAt": updated}
    if category:
        item["category"] = category
    return item


def _hit(key: str, score: float) -> dict:
    return {"id": key, "distance": score, "entity": {"memory_key": key}}


class _FakeMilvus:
    def __init__(self, hits: list[dict]):
        self._hits = hits
        self.search_calls: list[dict] = []

    def search(self, **kwargs):
        self.search_calls.append(kwargs)
        return [self._hits]


_COLLECTIONS = {("model-type", "model-name"): ["cust-1_memory_m"]}


class SearchMemoriesToolTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        memory_mod._memory_cache.clear()
        memory_mod._collection_cache.clear()

    async def _run(self, args, memories, hits=None, context=None,
                   collections=_COLLECTIONS, milvus_error=None):
        client = _FakeMilvus(hits or [])
        milvus = MagicMock(return_value=client)
        if milvus_error:
            milvus = MagicMock(side_effect=milvus_error)
        with (
            patch.object(memory_mod, "_get_cached_memories", return_value=memories),
            patch.object(memory_mod, "_milvus_client", milvus),
            patch.object(memory_mod, "_memory_collections", return_value=collections),
            patch.object(memory_mod, "_embed_query", return_value=[0.1, 0.2]),
        ):
            out = await SearchMemoriesTool().run(args, context or _context())
        self._milvus = milvus
        return out, client

    async def test_refuses_without_memory_consent_and_touches_no_data(self):
        loader = MagicMock()
        with patch.object(memory_mod, "_get_cached_memories", loader):
            for context in (_context(memory_enabled=False), _context(memory_enabled=None)):
                out = await SearchMemoriesTool().run({"query": "visa"}, context)
                self.assertIn("Memory is not enabled", out.content)
        loader.assert_not_called()

    async def test_empty_query_is_an_actionable_error(self):
        out, _ = await self._run({"query": "   "}, memories=[])
        self.assertIn("query is empty", out.content)

    async def test_searches_with_the_contexts_customer_id(self):
        memories = [_mem("MEM#a", "EPISODIC", "Worked at Amazon for 4.5 years.")]
        out, client = await self._run({"query": "employment history"}, memories,
                                      hits=[_hit("MEM#a", 0.8)])

        self._milvus.assert_called_once_with("cust-1")
        self.assertEqual(client.search_calls[0]["collection_name"], "cust-1_memory_m")
        self.assertEqual(client.search_calls[0]["output_fields"], ["memory_key"])
        self.assertIn("Worked at Amazon for 4.5 years.", out.content)

    async def test_joins_to_ddb_includes_all_kinds_and_renders_context(self):
        memories = [
            _mem("MEM#core", "CORE", "Works as an engineer.", "profile", "2026-09-20T03:39:24Z"),
            _mem("MEM#epi", "EPISODIC", "Is undergoing a PERM green card application.", "work",
                 "2026-09-21T00:41:55Z"),
        ]
        hits = [
            _hit("MEM#stale", 0.95),  # deleted memory, vector left behind — dropped
            _hit("MEM#epi", 0.81),
            _hit("MEM#epi", 0.50),    # worse chunk of the same memory — deduped
            _hit("MEM#core", 0.62),
        ]
        out, _ = await self._run({"query": "visa status"}, memories, hits=hits)

        self.assertIn("matching 'visa status' (2 match(es)", out.content)
        self.assertIn(
            "[1] Is undergoing a PERM green card application. "
            "(EPISODIC; work; updated 2026-09-21; similarity 0.81)",
            out.content,
        )
        self.assertIn(
            "[2] Works as an engineer. (CORE; profile; updated 2026-09-20; similarity 0.62)",
            out.content,
        )
        self.assertNotIn("MEM#stale", out.content)
        self.assertIn("may be out of date", out.content)

    async def test_min_score_filters_and_top_k_caps(self):
        memories = [_mem(f"MEM#{i}", "EPISODIC", f"Fact {i}.") for i in range(6)]
        hits = [_hit(f"MEM#{i}", 0.9 - i * 0.1) for i in range(6)]  # 0.9 … 0.4

        out, _ = await self._run({"query": "q", "top_k": 2}, memories, hits=hits)
        self.assertIn("(2 match(es)", out.content)
        self.assertIn("[1] Fact 0.", out.content)
        self.assertIn("[2] Fact 1.", out.content)
        self.assertNotIn("Fact 2.", out.content)

        out, _ = await self._run({"query": "q", "min_score": 0.75}, memories, hits=hits)
        self.assertIn("(2 match(es)", out.content)  # only 0.9 and 0.8 clear 0.75

    async def test_no_stored_memories_message(self):
        out, _ = await self._run({"query": "anything"}, memories=[])
        self.assertIn("No memories are stored for this user yet", out.content)
        self._milvus.assert_not_called()

    async def test_unindexed_memories_message(self):
        memories = [_mem("MEM#a", "EPISODIC", "Fact.")]
        out, _ = await self._run({"query": "q"}, memories, collections={})
        self.assertIn("none are indexed for semantic search yet", out.content)

    async def test_no_matches_message_names_the_floor(self):
        memories = [_mem("MEM#a", "EPISODIC", "Fact.")]
        out, _ = await self._run({"query": "quantum farming"}, memories,
                                 hits=[_hit("MEM#a", 0.2)])
        self.assertIn("No stored memories match 'quantum farming' at min_score >= 0.40", out.content)
        self.assertIn("lower min_score", out.content)

    async def test_search_failure_degrades_and_counts(self):
        memories = [_mem("MEM#a", "EPISODIC", "Fact.")]
        counted = []
        with patch("graph.memory_tool.count", lambda name, **k: counted.append((name, k))):
            out, _ = await self._run({"query": "q"}, memories,
                                     milvus_error=RuntimeError("zilliz down"))
        self.assertIn("Memory search failed for 'q'", out.content)
        self.assertIn(("memory_recall_failure_total", {"source": "tool"}), counted)


class ConsentBindTimeTests(unittest.TestCase):
    """The bind-time gate: _build_state strips memory tools without consent."""

    def _request(self, memory_enabled: bool):
        from models import RawData, RetrieveRequest

        return RetrieveRequest(
            customer_id="cust-1",
            client="test",
            data_type="text",
            raw_data=RawData(query_data="hi"),
            llm_credentials={},
            memory_enabled=memory_enabled,
        )

    def test_dropped_without_consent_kept_with_it(self):
        from routes.retrieve import _build_state

        tools = ["web_search", "search_memories", "search_knowledge_base"]
        without = _build_state(self._request(False), {}, tools)
        self.assertEqual(without["builtin_tools"], ["web_search", "search_knowledge_base"])
        with_consent = _build_state(self._request(True), {}, tools)
        self.assertEqual(with_consent["builtin_tools"], tools)

    def test_registered_but_never_implicit(self):
        self.assertTrue(get_registry().has("search_memories"))
        self.assertNotIn("search_memories", all_builtin_tool_names())
        self.assertIn("search_memories", MEMORY_CONSENT_TOOLS)


class KnowledgeDiscoveryExclusionTests(unittest.TestCase):
    """RETRIEVAL/knowledge search no longer surfaces raw memory vectors."""

    def test_memory_collections_are_excluded(self):
        from graph.nodes.retrieval import _discover_collections

        client = MagicMock()
        client.list_collections.return_value = [
            "notes_voyage_4_large",
            "email_voyage_4_large",
            "conversation_voyage_4_large",   # included: past-chat grounding (2026-10-20)
            "memory_voyage_4_large",         # excluded: consent-gated read paths own it
            "instructions_voyage_4_large",   # excluded: instruction search only
            "cust-1_notes_voyage",           # legacy per-customer: not a read path anymore
            "cust-1",                        # legacy unprefixed
        ]
        client.describe_collection.return_value = {"description": None}

        grouped = _discover_collections(client, (None, None))
        names = sorted(n for group in grouped.values() for n in group)
        self.assertEqual(
            names,
            ["conversation_voyage_4_large", "email_voyage_4_large", "notes_voyage_4_large"],
        )


if __name__ == "__main__":
    unittest.main()
