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


def _child(content="child report", usage=None, trace=None, error=None):
    return AsyncMock(return_value={
        "content": content,
        "usage": usage,
        "trace": trace or [],
        "artifacts": [],
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

    async def test_files_the_child_made_survive_its_failure(self):
        # Plan 1.10: a child that rendered a PDF and then failed (or reported
        # nothing) still made the file; dropping it lost the user's PDF.
        made = {"artifact_id": "a1", "key": "customers/c/attachments/a1",
                "media_type": "application/pdf", "filename": "r.pdf", "size_bytes": 10}
        for content, error in (("", "GraphRecursionError: limit"), ("", None)):
            spawn = AsyncMock(return_value={"content": content, "usage": None, "trace": [],
                                            "artifacts": [made], "error": error})
            with self.subTest(error=error):
                out = await SpawnAgentTool().run({"prompt": "x"}, _context(spawn=spawn))
                self.assertEqual([a.artifact_id for a in out.artifacts], ["a1"])

    async def test_long_arguments_in_the_child_trace_are_shortened(self):
        # Plan 1.9: the trace is persisted with the thinking steps.
        document = "word " * 5000
        trace = [{"node": "TOOL_EXECUTOR", "calls": [{"name": "generate_pdf",
                                                      "args": {"content_markdown": document}}]}]
        out = await SpawnAgentTool().run({"prompt": "x"}, _context(spawn=_child(trace=trace)))
        shown = out.details["subagent_trace"][0]["calls"][0]["args"]["content_markdown"]
        self.assertLess(len(shown), 200)
        self.assertIn("(25,000 chars)", shown)

    async def test_empty_prompt_and_missing_runtime_are_errors(self):
        out = await SpawnAgentTool().run({"prompt": "  "}, _context(spawn=_child()))
        self.assertIn("prompt is empty", out.content)
        out = await SpawnAgentTool().run({"prompt": "x"}, _context(spawn=None))
        self.assertIn("not available", out.content)


if __name__ == "__main__":
    unittest.main()
