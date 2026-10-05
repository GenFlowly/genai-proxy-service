"""
Unit tests for graph.knowledge_tool — the search_knowledge_base built-in.

Run with `python -m unittest tests.test_knowledge_tool`.

The tool is the bridge between the pipeline and agent shapes: the RETRIEVAL
node's search core exposed as a model-decided tool. Pinned here:

  * it searches with the CALLER's customer_id (tenant isolation comes from the
    context, never a model argument),
  * model-supplied knobs are clamped to sane bounds,
  * every failure path degrades to a message the model can act on — the tool
    never raises out of run().
"""
import unittest
from unittest.mock import AsyncMock, patch

from graph.knowledge_tool import SearchKnowledgeBaseTool
from graph_tools.base import ToolContext


def _context() -> ToolContext:
    return ToolContext(customer_id="cust-1", store=None)


def _hit(title: str, note: str, score: float) -> dict:
    return {"id": "1", "distance": score, "entity": {"title": title, "note_value": note},
            "source_collection": "cust-1"}


class SearchKnowledgeBaseTests(unittest.IsolatedAsyncioTestCase):
    async def _run(self, args, results=None, error=None):
        search = AsyncMock(return_value=results or [])
        if error:
            search = AsyncMock(side_effect=error)
        # The tool imports search_knowledge lazily at call time, so patching
        # the retrieval module's attribute is sufficient.
        with patch("graph.nodes.retrieval.search_knowledge", search):
            out = await SearchKnowledgeBaseTool().run(args, _context())
        return out, search

    async def test_searches_with_the_contexts_customer_id(self):
        _, search = await self._run({"query": "refund policy"}, results=[_hit("Refunds", "30 days", 0.9)])

        kwargs = search.await_args.kwargs
        self.assertEqual(kwargs["customer_id"], "cust-1")
        self.assertEqual(kwargs["query"], "refund policy")

    async def test_renders_numbered_results_with_titles_and_scores(self):
        out, _ = await self._run(
            {"query": "q"},
            results=[_hit("Refunds", "30 days for digital goods", 0.91),
                     _hit("Shipping", "ships in 2 days", 0.72)],
        )

        self.assertIn("[1] Refunds (similarity 0.91)", out.content)
        self.assertIn("30 days for digital goods", out.content)
        self.assertIn("[2] Shipping (similarity 0.72)", out.content)
        # No artifacts, no web-style sources — knowledge chunks have no URL.
        self.assertEqual(out.sources, [])
        self.assertEqual(out.artifacts, [])

    async def test_empty_query_is_an_error_message_not_a_search(self):
        out, search = await self._run({"query": "   "})

        self.assertIn("query is empty", out.content)
        search.assert_not_awaited()

    async def test_clamps_top_k_and_min_score(self):
        _, search = await self._run({"query": "q", "top_k": 999, "min_score": 7})

        kwargs = search.await_args.kwargs
        self.assertEqual(kwargs["top_n"], 20)
        self.assertEqual(kwargs["similarity_threshold"], 1.0)

    async def test_non_numeric_knobs_fall_back_to_defaults(self):
        _, search = await self._run({"query": "q", "top_k": "lots", "min_score": "very"})

        kwargs = search.await_args.kwargs
        self.assertEqual(kwargs["top_n"], 5)
        self.assertEqual(kwargs["similarity_threshold"], 0.6)

    async def test_no_results_tells_the_model_how_to_retry(self):
        out, _ = await self._run({"query": "unicorns"}, results=[])

        self.assertIn("No knowledge base results", out.content)
        self.assertIn("min_score", out.content)

    async def test_search_failure_degrades_to_an_actionable_message(self):
        out, _ = await self._run({"query": "q"}, error=RuntimeError("zilliz down"))

        self.assertIn("Knowledge base search failed", out.content)
        self.assertNotIn("zilliz down", out.content)  # no infra detail leaks to the model


if __name__ == "__main__":
    unittest.main()
