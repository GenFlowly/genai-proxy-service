"""
Unit tests for the TOOL_EXECUTOR node.

Run with `python -m unittest tests.test_tool_executor`.

This node had no test coverage at all. What it does is security-relevant on two
counts, and both are pinned here:

  * what may execute is decided by the request's enabled set, never by whatever
    is registered in the process,
  * credentials are resolved once per turn, off the event loop, and reach tools
    only through ToolContext.secrets — never a process env var, never graph
    state (which the durable runtime checkpoints to Postgres).
"""
import unittest
from unittest.mock import AsyncMock, patch

import graph.nodes.tool_executor as tool_executor_module
from graph.nodes.tool_executor import tool_executor
from graph_tools.base import GraphTool, Source, ToolContext, ToolResult


class _Recorder(GraphTool):
    """A tool that records the context it was handed."""

    def __init__(self, name, credential_ref=None, raises=None, sources=None):
        self.name = name
        self.description = f"stub {name}"
        self.parameters = {"type": "object", "properties": {}}
        self.credential_ref = credential_ref
        self._raises = raises
        self._sources = sources or []
        self.seen_context: ToolContext | None = None
        self.seen_args: dict | None = None

    async def run(self, args: dict, context: ToolContext) -> ToolResult:
        self.seen_args = args
        self.seen_context = context
        if self._raises:
            raise self._raises
        return ToolResult(content=f"{self.name} ran", sources=self._sources)


def _state(calls, enabled):
    return {
        "customer_id": "cust-1",
        "tool_calls": calls,
        "builtin_tools": enabled,
        "generated_response": "thinking...",
    }


async def _run(state, tools, resolved=None, resolve_error=None):
    """Execute the node with `tools` as the request's enabled set."""
    resolver = AsyncMock(return_value=resolved or {})
    if resolve_error:
        resolver = AsyncMock(side_effect=resolve_error)
    with patch.object(tool_executor_module, "tools_for", return_value=tools), \
            patch.object(tool_executor_module, "resolve_tool_credentials") as sync_resolver, \
            patch.object(tool_executor_module.asyncio, "to_thread", resolver):
        sync_resolver.return_value = resolved or {}
        return await tool_executor("node-1")(state)


class EnablementTests(unittest.IsolatedAsyncioTestCase):
    async def test_executes_an_enabled_tool(self):
        tool = _Recorder("web_search")
        out = await _run(_state([{"id": "1", "name": "web_search", "args": {"q": "x"}}],
                                ["web_search"]), [tool])

        self.assertEqual(tool.seen_args, {"q": "x"})
        self.assertEqual(out["loop_messages"][1]["content"], "web_search ran")
        self.assertIsNone(out["tool_calls"])

    async def test_drops_a_call_that_is_not_enabled(self):
        # tools_for returns only what this request enabled; anything else is
        # the caller's to execute.
        out = await _run(_state([{"id": "1", "name": "caller_tool"}], []), [])

        self.assertEqual(out, {"tool_calls": None})

    async def test_mixed_turn_executes_only_the_enabled_subset(self):
        tool = _Recorder("web_search")
        out = await _run(
            _state([{"id": "1", "name": "caller_tool"},
                    {"id": "2", "name": "web_search"}], ["web_search"]),
            [tool],
        )

        recorded = out["loop_messages"][0]["tool_calls"]
        self.assertEqual([c["name"] for c in recorded], ["web_search"])
        # No dangling tool_call id for the dropped caller tool.
        self.assertEqual(len(out["loop_messages"]), 2)

    async def test_clears_generated_response_so_a_preamble_cannot_leak(self):
        out = await _run(_state([{"id": "1", "name": "t"}], ["t"]), [_Recorder("t")])
        self.assertIsNone(out["generated_response"])


class CredentialTests(unittest.IsolatedAsyncioTestCase):
    async def test_injects_resolved_credentials_into_the_tool_context(self):
        tool = _Recorder("web_search", credential_ref="WEB_SEARCH")
        await _run(
            _state([{"id": "1", "name": "web_search"}], ["web_search"]),
            [tool],
            resolved={"WEB_SEARCH": {"api_key": "tvly-customer"}},
        )

        self.assertEqual(tool.seen_context.secrets("WEB_SEARCH"), {"api_key": "tvly-customer"})
        self.assertEqual(tool.seen_context.customer_id, "cust-1")

    async def test_a_tool_sees_only_an_empty_map_for_another_tools_ref(self):
        tool = _Recorder("web_search", credential_ref="WEB_SEARCH")
        await _run(
            _state([{"id": "1", "name": "web_search"}], ["web_search"]),
            [tool],
            resolved={"WEB_SEARCH": {"api_key": "k"}},
        )

        self.assertEqual(tool.seen_context.secrets("EMAIL"), {})

    async def test_resolution_is_skipped_when_no_tool_needs_credentials(self):
        tool = _Recorder("generate_pdf")
        resolver = AsyncMock(return_value={})
        with patch.object(tool_executor_module, "tools_for", return_value=[tool]), \
                patch.object(tool_executor_module.asyncio, "to_thread", resolver):
            await tool_executor("node-1")(
                _state([{"id": "1", "name": "generate_pdf"}], ["generate_pdf"])
            )

        resolver.assert_not_awaited()

    async def test_resolution_happens_off_the_event_loop(self):
        # boto3 + KMS are blocking and this process serves every tenant on one
        # loop, so the fetch must go through asyncio.to_thread.
        tool = _Recorder("web_search", credential_ref="WEB_SEARCH")
        resolver = AsyncMock(return_value={"WEB_SEARCH": {"api_key": "k"}})
        with patch.object(tool_executor_module, "tools_for", return_value=[tool]), \
                patch.object(tool_executor_module, "resolve_tool_credentials") as sync_resolver, \
                patch.object(tool_executor_module.asyncio, "to_thread", resolver):
            await tool_executor("node-1")(
                _state([{"id": "1", "name": "web_search"}], ["web_search"])
            )

        resolver.assert_awaited_once()
        self.assertIs(resolver.await_args.args[0], sync_resolver)
        self.assertEqual(resolver.await_args.args[1], "cust-1")
        self.assertEqual(resolver.await_args.args[2], {"WEB_SEARCH"})

    async def test_resolution_failure_does_not_abort_the_turn(self):
        # The tool still runs and degrades on an empty credential map, so the
        # model gets an answer it can act on.
        tool = _Recorder("web_search", credential_ref="WEB_SEARCH")
        out = await _run(
            _state([{"id": "1", "name": "web_search"}], ["web_search"]),
            [tool],
            resolve_error=RuntimeError("kms denied"),
        )

        self.assertEqual(tool.seen_context.secrets("WEB_SEARCH"), {})
        self.assertEqual(out["loop_messages"][1]["content"], "web_search ran")

    async def test_credentials_never_appear_in_the_returned_state(self):
        tool = _Recorder("web_search", credential_ref="WEB_SEARCH")
        out = await _run(
            _state([{"id": "1", "name": "web_search"}], ["web_search"]),
            [tool],
            resolved={"WEB_SEARCH": {"api_key": "tvly-secret-value"}},
        )

        self.assertNotIn("tvly-secret-value", repr(out))


class SourceTests(unittest.IsolatedAsyncioTestCase):
    """Structured sources are the one citation path for all tools: the host
    numbers them turn-globally, renders them into the tool message the model
    reads, and returns the {index,title,url} snapshot the streaming layer emits
    as web_sources — so inline [n] markers in the answer resolve to links."""

    async def test_sources_are_numbered_and_rendered_into_the_tool_message(self):
        tool = _Recorder("web_search", sources=[
            Source(title="A", url="https://a", content="snippet a"),
            Source(title="B", url="https://b", published_date="2026-09-01"),
        ])
        out = await _run(_state([{"id": "1", "name": "web_search"}], ["web_search"]), [tool])

        msg = out["loop_messages"][1]["content"]
        self.assertIn("[1] A (https://a)", msg)
        self.assertIn("snippet a", msg)
        self.assertIn("[2] B (https://b)", msg)
        self.assertIn("published 2026-09-01", msg)
        self.assertEqual(out["tool_sources"], [
            {"index": 1, "title": "A", "url": "https://a"},
            {"index": 2, "title": "B", "url": "https://b"},
        ])

    async def test_numbering_continues_across_rounds(self):
        # A prior TOOL_EXECUTOR round this turn already emitted two sources.
        state = _state([{"id": "1", "name": "web_search"}], ["web_search"])
        state["tool_sources"] = [
            {"index": 1, "title": "X", "url": "u1"},
            {"index": 2, "title": "Y", "url": "u2"},
        ]
        tool = _Recorder("web_search", sources=[Source(title="C", url="https://c")])
        out = await _run(state, [tool])

        # New source is numbered [3], not [1] — no collision across rounds.
        self.assertIn("[3] C (https://c)", out["loop_messages"][1]["content"])
        # Full snapshot (prior + new) so the emitted web_sources is complete.
        self.assertEqual(out["tool_sources"], [
            {"index": 1, "title": "X", "url": "u1"},
            {"index": 2, "title": "Y", "url": "u2"},
            {"index": 3, "title": "C", "url": "https://c"},
        ])

    async def test_no_sources_means_no_tool_sources_key(self):
        # A tool that cites nothing leaves tool_sources untouched (no empty write).
        out = await _run(_state([{"id": "1", "name": "t"}], ["t"]), [_Recorder("t")])
        self.assertNotIn("tool_sources", out)
        self.assertEqual(out["loop_messages"][1]["content"], "t ran")

    async def test_trace_carries_a_per_call_breakdown_with_its_own_sources(self):
        # Two calls to the SAME tool in one round must stay distinguishable in
        # the trace — this is what the thinking panel renders instead of a
        # flattened "web_search, web_search" with no query and no per-call
        # source attribution.
        tool = _Recorder("web_search", sources=[Source(title="A", url="https://a")])
        out = await _run(
            _state(
                [
                    {"id": "1", "name": "web_search", "args": {"query": "first"}},
                    {"id": "2", "name": "web_search", "args": {"query": "second"}},
                ],
                ["web_search"],
            ),
            [tool],
        )

        calls = out["trace"][0]["calls"]
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]["name"], "web_search")
        self.assertEqual(calls[0]["args"], {"query": "first"})
        self.assertEqual(calls[1]["args"], {"query": "second"})
        # Each call's sources are numbered turn-globally and attributed only
        # to that call, not merged across both.
        self.assertEqual(calls[0]["sources"], [{"index": 1, "title": "A", "url": "https://a"}])
        self.assertEqual(calls[1]["sources"], [{"index": 2, "title": "A", "url": "https://a"}])
        self.assertIsNone(calls[0]["error"])


class FailureTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_failing_tool_becomes_content_not_an_exception(self):
        tool = _Recorder("web_search", raises=RuntimeError("upstream down"))
        out = await _run(_state([{"id": "1", "name": "web_search"}], ["web_search"]), [tool])

        self.assertIn("Error executing web_search", out["loop_messages"][1]["content"])
        self.assertEqual(out["loop_messages"][1]["tool_call_id"], "1")

    async def test_one_failure_does_not_stop_the_other_calls(self):
        bad = _Recorder("a", raises=RuntimeError("nope"))
        good = _Recorder("b")
        out = await _run(
            _state([{"id": "1", "name": "a"}, {"id": "2", "name": "b"}], ["a", "b"]),
            [bad, good],
        )

        contents = [m["content"] for m in out["loop_messages"][1:]]
        self.assertIn("Error executing a", contents[0])
        self.assertEqual(contents[1], "b ran")

    async def test_a_failing_call_records_its_error_in_the_trace(self):
        tool = _Recorder("web_search", raises=RuntimeError("upstream down"))
        out = await _run(_state([{"id": "1", "name": "web_search"}], ["web_search"]), [tool])

        call = out["trace"][0]["calls"][0]
        self.assertEqual(call["error"], "upstream down")
        self.assertEqual(call["sources"], [])


if __name__ == "__main__":
    unittest.main()
