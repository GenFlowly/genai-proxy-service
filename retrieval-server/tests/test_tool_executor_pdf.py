"""
Unit tests for the TOOL_EXECUTOR node's PDF-plan behaviour.

Run with `python -m unittest tests.test_tool_executor_pdf`.

- calls cut off at the output limit are answered, never executed (1.8);
- the PDF and file tools get their per-request runtime (2.1, 3.1, 3.6, 6.1,
  6.2) and render stats reach the metrics (1.3);
- a sub-agent spawned in the first round shares the parent's namespace (3.4);
- whole documents are stubbed in the replayed assistant turn (3.5) and
  shortened in the trace (1.9).
"""
import unittest
from unittest.mock import patch

import graph.nodes.tool_executor as tool_executor_module
from graph.nodes.tool_executor import tool_executor
from graph_tools.base import Artifact, GraphTool, ToolContext, ToolResult


class _Tool(GraphTool):
    def __init__(self, name, result=None):
        self.name = name
        self.description = name
        self.parameters = {"type": "object", "properties": {}}
        self.credential_ref = None
        self.result = result or ToolResult(content=f"{name} ran")
        self.runs = 0
        self.context: ToolContext | None = None

    async def run(self, args, context):
        self.runs += 1
        self.context = context
        return self.result


def _state(calls, enabled, **extra):
    return {"customer_id": "cust-1", "tool_calls": calls, "builtin_tools": enabled,
            "generated_response": "", **extra}


async def _run(state, tools, config=None):
    node_configs = {"node-1": config or {}}
    with patch.object(tool_executor_module, "tools_for", return_value=tools):
        return await tool_executor("node-1")({**state, "node_configs": node_configs})


class TruncatedCallTests(unittest.IsolatedAsyncioTestCase):
    async def test_cut_off_calls_are_refused_not_run(self):
        tool = _Tool("generate_pdf")
        call = {"id": "c1", "name": "generate_pdf", "args": {}, "truncated": True,
                "truncation_reason": "max_tokens"}
        out = await _run(_state([call], ["generate_pdf"]), [tool])
        self.assertEqual(tool.runs, 0)
        result = out["loop_messages"][1]
        self.assertEqual(result["tool_call_id"], "c1")
        self.assertIn("NOT executed", result["content"])
        self.assertNotIn("fs_write", result["content"])
        self.assertEqual(out["generated_artifacts"], [])

    async def test_refusal_suggests_fs_write_when_enabled(self):
        call = {"id": "c1", "name": "generate_pdf", "args": {}, "truncated": True,
                "truncation_reason": "length"}
        out = await _run(_state([call], ["generate_pdf", "fs_write"]),
                         [_Tool("generate_pdf"), _Tool("fs_write")])
        self.assertIn("fs_write", out["loop_messages"][1]["content"])

    async def test_malformed_calls_get_the_json_message(self):
        call = {"id": "c1", "name": "generate_pdf", "args": {}, "truncated": True,
                "truncation_reason": "invalid_tool_call"}
        out = await _run(_state([call], ["generate_pdf"]), [_Tool("generate_pdf")])
        self.assertIn("not valid JSON", out["loop_messages"][1]["content"])


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_pdf_tools_get_the_request_runtime(self):
        tool = _Tool("generate_pdf")
        files = [{"attachment_id": "a1", "s3_key": "customers/other/attachments/a1",
                  "media_type": "application/pdf", "filename": "x.pdf", "origin": "generated"}]
        await _run(
            _state([{"id": "1", "name": "generate_pdf", "args": {}}], ["generate_pdf"],
                   conversation_files=files, locale="de-DE", pdf_renderer="typst"),
            [tool],
            config={"tool_settings": {"generate_pdf": {"company_name": "Acme", "default_page_size": "Letter"}}},
        )
        runtime = tool.context.runtime
        self.assertEqual(runtime["pdf_renderer"], "typst")
        self.assertEqual(runtime["locale"], "de-DE")
        self.assertEqual(runtime["pdf_settings"], {"company_name": "Acme", "default_page_size": "Letter"})
        self.assertIsNone(runtime["pdf_settings_owner"])
        self.assertEqual(runtime["conversation_files"]["a1"]["s3_key"], "customers/other/attachments/a1")
        self.assertTrue(callable(runtime["render_pdf"]))
        self.assertTrue(callable(runtime["read_scratch"]))
        self.assertIn("generate_pdf", runtime["enabled_tools"])
        self.assertEqual(runtime["pdf_limits"]["typst"]["max_chars"], 150_000)
        self.assertNotIn("pdf_script_route", runtime)
        self.assertNotIn("pdf_fonts_cover", runtime)

    async def test_a_run_pinned_to_the_removed_renderer_gets_typst(self):
        # Plan 5.2: state recovered from a run enqueued before the removal.
        tool = _Tool("generate_pdf")
        await _run(
            _state([{"id": "1", "name": "generate_pdf", "args": {}}], ["generate_pdf"],
                   pdf_renderer="x2p_v1", pdf_script_route="typst"),
            [tool],
        )
        self.assertEqual(tool.context.runtime["pdf_renderer"], "typst")
        self.assertEqual(set(tool.context.runtime["pdf_limits"]), {"typst"})

    async def test_the_graph_owner_scopes_the_letterhead_settings(self):
        from graph.tools_runtime import GRAPH_OWNER_KEY

        tool = _Tool("generate_pdf")
        await _run(
            _state([{"id": "1", "name": "generate_pdf", "args": {}}], ["generate_pdf"]),
            [tool],
            config={GRAPH_OWNER_KEY: "System",
                    "tool_settings": {"generate_pdf": {"logo_attachment_id": "logo-0001"}}},
        )
        self.assertEqual(tool.context.runtime["pdf_settings_owner"], "System")

    async def test_pdf_tools_record_their_own_stats(self):
        # Recorded inside the tool run (the durable tool_invoke step), so a
        # recovered run replaying the memoized result never counts it twice.
        from graph import pdf_metrics

        tool = _Tool("generate_pdf")
        await _run(_state([{"id": "1", "name": "generate_pdf", "args": {}}], ["generate_pdf"]), [tool])
        self.assertIs(tool.context.runtime["record_pdf_stats"], pdf_metrics.record)


class FirstRoundSpawnTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_first_round_child_shares_the_parents_namespace(self):
        seen = {}

        async def fake_run_subagent(parent_state, profile, prompt, depth):
            seen["ns"] = (parent_state.get("scratch") or {}).get("fs_namespace")
            return {"content": "child done", "usage": None, "trace": [], "artifacts": [], "error": None}

        class _Spawner(_Tool):
            async def run(self, args, context):
                return ToolResult(content=str(await context.runtime["spawn"]({"name": "general"}, "go")))

        with patch("graph.subagent.run_subagent", fake_run_subagent):
            out = await _run(_state([{"id": "1", "name": "spawn_agent", "args": {}}], ["spawn_agent"]),
                             [_Spawner("spawn_agent")])
        self.assertIsNotNone(seen["ns"])
        self.assertEqual(seen["ns"], out["scratch"]["fs_namespace"])


class ReplayErrorTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_replay_divergence_in_a_child_fails_the_parent(self):
        import tool_ledger
        from graph import subagent

        class _Graph:
            async def ainvoke(self, state, config=None):
                raise tool_ledger.ReplayDivergence("wf-1", 4, "call-a", "call-b")

        parent = {"customer_id": "c", "llm_provider": "openai"}
        with patch.object(subagent, "_get_child_graph", return_value=_Graph()):
            with self.assertRaises(tool_ledger.ReplayDivergence):
                await subagent.run_subagent(parent, {"name": "general"}, "go", 1)

    def test_replay_errors_reach_the_user_as_a_lost_run(self):
        import tool_ledger
        from run_events import RUN_LOST_MESSAGE
        from streaming import user_facing_llm_error

        kind, message = user_facing_llm_error(tool_ledger.ReplayDivergence("wf-1", 4, "call-a", "call-b"), "openai")
        self.assertEqual((kind, message), ("run_lost", RUN_LOST_MESSAGE))
        self.assertNotIn("wf-1", message)


class DocumentStubTests(unittest.IsolatedAsyncioTestCase):
    async def test_whole_documents_are_stubbed_for_replay_and_trace(self):
        artifact = Artifact(artifact_id="art-1", key="k", media_type="application/pdf",
                            filename="report.pdf", size_bytes=10)
        tool = _Tool("generate_pdf", ToolResult(content="PDF created", artifacts=[artifact]))
        document = "word " * 10_000
        out = await _run(_state(
            [{"id": "1", "name": "generate_pdf", "args": {"content_markdown": document, "filename": "report.pdf"}}],
            ["generate_pdf"]), [tool])
        replayed = out["loop_messages"][0]["tool_calls"][0]["args"]
        self.assertEqual(replayed["content_markdown"], "<50,000 chars; saved as report.pdf (artifact art-1)>")
        self.assertEqual(replayed["filename"], "report.pdf")
        traced = out["trace"][0]["calls"][0]["args"]["content_markdown"]
        self.assertLess(len(traced), 200)

    async def test_fs_write_content_is_stubbed_with_its_path(self):
        out = await _run(_state(
            [{"id": "1", "name": "fs_write", "args": {"path": "docs/a.md", "content": "x" * 3000}}],
            ["fs_write"]), [_Tool("fs_write")])
        self.assertEqual(out["loop_messages"][0]["tool_calls"][0]["args"]["content"],
                         "<3,000 chars; written to scratch:docs/a.md>")

    async def test_short_arguments_are_kept(self):
        out = await _run(_state(
            [{"id": "1", "name": "generate_pdf", "args": {"content_markdown": "short", "filename": "a.pdf"}}],
            ["generate_pdf"]), [_Tool("generate_pdf")])
        self.assertEqual(out["loop_messages"][0]["tool_calls"][0]["args"]["content_markdown"], "short")


if __name__ == "__main__":
    unittest.main()
