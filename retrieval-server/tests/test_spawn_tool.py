"""
Unit tests for graph/spawn_tool.py — delegation to subagents.

Run with `python -m unittest tests.test_spawn_tool`.

The child runtime itself (graph/subagent.py) is exercised structurally in
tests.test_agent_template-style compile checks; here the tool's POLICY is
pinned: depth cap, profile resolution, degradation when the child fails, and
that the child's spend/trace flow back through the ToolResult fields the
executor accumulates.
"""
import unittest
from unittest.mock import AsyncMock

from graph_tools.base import ToolContext
from graph.spawn_tool import SpawnAgentTool
from graph.subagent import GENERAL_PROFILE, resolve_profile


def _context(depth=0, subagents=None, spawn=None) -> ToolContext:
    context = ToolContext(customer_id="cust-1", store=None)
    context.runtime.update({
        "depth": depth,
        "subagents": subagents or [],
        "spawn": spawn,
    })
    return context


def _child(content="child report", usage=None, trace=None, error=None, sources=None):
    return AsyncMock(return_value={
        "content": content,
        "usage": usage,
        "trace": trace or [],
        "artifacts": [],
        "sources": sources or [],
        "error": error,
    })


class ResolveProfileTests(unittest.TestCase):
    def test_general_is_always_available(self):
        self.assertEqual(resolve_profile([], None), GENERAL_PROFILE)
        self.assertEqual(resolve_profile(None, "general"), GENERAL_PROFILE)

    def test_configured_profile_wins_by_name_and_unknown_is_none(self):
        researcher = {"name": "researcher", "tools": ["web_search"]}
        self.assertEqual(resolve_profile([researcher], "researcher"), researcher)
        self.assertIsNone(resolve_profile([researcher], "reviewer"))


class SpawnAgentToolTests(unittest.IsolatedAsyncioTestCase):
    async def test_delegates_to_the_resolved_profile_and_wraps_the_report(self):
        spawn = _child(usage={"total_tokens": 123, "input_tokens": 100, "output_tokens": 23})
        researcher = {"name": "researcher", "description": "digs deep", "tools": ["web_search"]}
        out = await SpawnAgentTool().run(
            {"prompt": "Investigate X", "agent_type": "researcher"},
            _context(subagents=[researcher], spawn=spawn),
        )

        profile, prompt = spawn.await_args.args
        self.assertEqual(profile, researcher)
        self.assertEqual(prompt, "Investigate X")
        self.assertIn("Report from the 'researcher' subagent", out.content)
        self.assertIn("child report", out.content)
        # Spend and trace flow back for the executor to accumulate/surface.
        self.assertEqual(out.usage["total_tokens"], 123)
        self.assertEqual(out.details["subagent"], "researcher")

    async def test_cited_child_sources_flow_back_with_compacted_markers(self):
        # The child cites [2] and [5] of its own turn-global numbering; the
        # uncited entry is dropped, the kept ones become structured ToolResult
        # sources, and the report's markers are compacted to 1..k so the
        # executor can renumber them into the PARENT's turn-global sequence.
        spawn = _child(
            content="PSE has an API [2]. WM too [5]. See footnote [9].",
            sources=[
                {"index": 1, "title": "Junk", "url": "https://junk"},
                {"index": 2, "title": "PSE", "url": "https://pse"},
                {"index": 5, "title": "WM", "url": "https://wm"},
            ],
        )
        out = await SpawnAgentTool().run({"prompt": "x"}, _context(spawn=spawn))

        self.assertEqual(
            [(s.title, s.url) for s in out.sources],
            [("PSE", "https://pse"), ("WM", "https://wm")],
        )
        # [9] matches no child source, so it is not a citation — left alone.
        self.assertIn("PSE has an API [1]. WM too [2]. See footnote [9].", out.content)

    async def test_uncited_report_keeps_full_child_provenance(self):
        spawn = _child(content="no inline markers here", sources=[
            {"index": 1, "title": "A", "url": "https://a"},
            {"index": 2, "title": "B", "url": "https://b"},
        ])
        out = await SpawnAgentTool().run({"prompt": "x"}, _context(spawn=spawn))

        self.assertEqual([(s.title, s.url) for s in out.sources],
                         [("A", "https://a"), ("B", "https://b")])
        self.assertIn("no inline markers here", out.content)

    async def test_child_without_sources_cites_nothing(self):
        out = await SpawnAgentTool().run({"prompt": "x"}, _context(spawn=_child()))
        self.assertEqual(out.sources, [])

    async def test_depth_cap_refuses_without_spawning(self):
        spawn = _child()
        out = await SpawnAgentTool().run(
            {"prompt": "go deeper"}, _context(depth=2, spawn=spawn)
        )
        self.assertIn("nesting limit", out.content)
        spawn.assert_not_awaited()

    async def test_unknown_agent_type_names_the_available_ones(self):
        out = await SpawnAgentTool().run(
            {"prompt": "x", "agent_type": "reviewer"},
            _context(subagents=[{"name": "researcher", "description": "d"}], spawn=_child()),
        )
        self.assertIn("unknown agent_type 'reviewer'", out.content)
        self.assertIn("researcher", out.content)

    async def test_child_failure_degrades_to_an_actionable_message(self):
        out = await SpawnAgentTool().run(
            {"prompt": "x"},
            _context(spawn=_child(content="", error="GraphRecursionError: limit")),
        )
        self.assertIn("subagent failed", out.content)
        self.assertIn("do the work yourself", out.content.lower())

    async def test_empty_prompt_and_missing_runtime_are_errors(self):
        out = await SpawnAgentTool().run({"prompt": "  "}, _context(spawn=_child()))
        self.assertIn("prompt is empty", out.content)
        out = await SpawnAgentTool().run({"prompt": "x"}, _context(spawn=None))
        self.assertIn("not available", out.content)


if __name__ == "__main__":
    unittest.main()
