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


class ConcurrencyTests(unittest.IsolatedAsyncioTestCase):
    """A turn's calls execute concurrently (the model issued them together,
    before seeing any result), but rendering stays in call order so
    loop_messages and citation numbering are deterministic."""

    async def test_calls_in_one_turn_run_concurrently(self):
        # Each tool waits for the OTHER to start before finishing. Sequential
        # execution deadlocks here; the wait_for timeout is the failure mode.
        import asyncio

        started_a, started_b = asyncio.Event(), asyncio.Event()

        class _Gate(GraphTool):
            def __init__(self, name, mine, other):
                self.name, self.description = name, "gate"
                self.parameters = {"type": "object", "properties": {}}
                self.credential_ref = None
                self._mine, self._other = mine, other

            async def run(self, args, context):
                self._mine.set()
                await asyncio.wait_for(self._other.wait(), timeout=2)
                return ToolResult(content=f"{self.name} ran")

        out = await asyncio.wait_for(
            _run(
                _state([{"id": "1", "name": "a"}, {"id": "2", "name": "b"}], ["a", "b"]),
                [_Gate("a", started_a, started_b), _Gate("b", started_b, started_a)],
            ),
            timeout=5,
        )

        self.assertEqual([m["content"] for m in out["loop_messages"][1:]], ["a ran", "b ran"])

    async def test_results_and_numbering_follow_call_order_not_completion_order(self):
        # The FIRST call finishes last; its message and its sources must still
        # come first, with turn-global numbering unchanged.
        import asyncio

        class _Slow(_Recorder):
            async def run(self, args, context):
                await asyncio.sleep(0.05)
                return ToolResult(content="slow ran", sources=[Source(title="S", url="https://s")])

        slow = _Slow("slow", sources=[Source(title="S", url="https://s")])
        fast = _Recorder("fast", sources=[Source(title="F", url="https://f")])
        out = await _run(
            _state([{"id": "1", "name": "slow"}, {"id": "2", "name": "fast"}], ["slow", "fast"]),
            [slow, fast],
        )

        self.assertIn("[1] S (https://s)", out["loop_messages"][1]["content"])
        self.assertIn("[2] F (https://f)", out["loop_messages"][2]["content"])
        self.assertEqual(out["tool_sources"], [
            {"index": 1, "title": "S", "url": "https://s"},
            {"index": 2, "title": "F", "url": "https://f"},
        ])


class HarnessStateTests(unittest.IsolatedAsyncioTestCase):
    """The executor is the host side of the harness contract: tool
    state_patches land in scratch, tool-incurred LLM spend lands in usage,
    the scratch-FS namespace is pinned, and an updated todo list rides the
    trace entry (→ the thinking_step event → proxy persistence)."""

    async def test_state_patch_lands_in_scratch_and_namespace_is_pinned(self):
        class _Patcher(_Recorder):
            async def run(self, args, context):
                return ToolResult(content="ok", state_patch={
                    "todos": [{"content": "step", "status": "pending"}],
                })

        out = await _run(_state([{"id": "1", "name": "t"}], ["t"]), [_Patcher("t")])

        self.assertEqual(out["scratch"]["todos"], [{"content": "step", "status": "pending"}])
        self.assertTrue(out["scratch"]["fs_namespace"])
        # ...and the trace entry carries the updated checklist for streaming.
        self.assertEqual(out["trace"][0]["todos"], out["scratch"]["todos"])

    async def test_existing_fs_namespace_is_reused_and_fs_index_accumulates(self):
        class _FsWriter(_Recorder):
            async def run(self, args, context):
                return ToolResult(content="ok", state_patch={"fs_files": {"b.txt": 2}})

        state = _state([{"id": "1", "name": "t"}], ["t"])
        state["scratch"] = {"fs_namespace": "ns-fixed", "fs_files": {"a.txt": 1}}
        out = await _run(state, [_FsWriter("t")])

        self.assertEqual(out["scratch"]["fs_namespace"], "ns-fixed")
        self.assertEqual(out["scratch"]["fs_files"], {"a.txt": 1, "b.txt": 2})

    async def test_tool_usage_joins_the_usage_channel(self):
        class _Spender(_Recorder):
            async def run(self, args, context):
                return ToolResult(content="ok", usage={
                    "input_tokens": 10, "output_tokens": 5, "total_tokens": 15,
                })

        out = await _run(
            _state([{"id": "1", "name": "a"}, {"id": "2", "name": "b"}], ["a", "b"]),
            [_Spender("a"), _Spender("b")],
        )

        self.assertEqual(out["usage"]["total_tokens"], 30)

    async def test_no_tool_usage_means_no_usage_key(self):
        out = await _run(_state([{"id": "1", "name": "t"}], ["t"]), [_Recorder("t")])
        self.assertNotIn("usage", out)

    async def test_details_surface_in_the_calls_trace_only(self):
        class _Detailed(_Recorder):
            async def run(self, args, context):
                return ToolResult(content="report", details={"subagent": "general"})

        out = await _run(_state([{"id": "1", "name": "t"}], ["t"]), [_Detailed("t")])

        self.assertEqual(out["trace"][0]["calls"][0]["details"], {"subagent": "general"})
        self.assertEqual(out["loop_messages"][1]["content"], "report")

    async def test_runtime_hands_tools_the_fs_prefix_depth_and_spawn(self):
        tool = _Recorder("t")
        state = _state([{"id": "1", "name": "t"}], ["t"])
        state["agent_depth"] = 1
        await _run(state, [tool])

        runtime = tool.seen_context.runtime
        self.assertEqual(runtime["depth"], 1)
        self.assertTrue(runtime["fs_prefix"].startswith("customers/cust-1/agent-fs/"))
        self.assertTrue(callable(runtime["spawn"]))


class SpillTests(unittest.IsolatedAsyncioTestCase):
    """Oversized tool results spill: full content to the scratch FS, a
    structure-preserving excerpt (head + tail, elision marker, fs path) into
    loop_messages — never a dropped message, never a broken tool_call_id."""

    class _Store:
        def __init__(self, fail=False):
            self.fail = fail
            self.writes: dict[str, bytes] = {}

        def put(self, key, data, content_type, *, tags=None, filename=None):
            if self.fail:
                raise RuntimeError("s3 down")
            self.writes[key] = data

    async def _run_with_store(self, state, tools, store):
        from graph.tools_runtime import make_tool_context

        def _context_with_store(customer_id, secrets=None):
            context = make_tool_context(customer_id, secrets=secrets)
            context.store = store
            return context

        resolver = AsyncMock(return_value={})
        with patch.object(tool_executor_module, "tools_for", return_value=tools), \
                patch.object(tool_executor_module, "make_tool_context", _context_with_store), \
                patch.object(tool_executor_module.asyncio, "to_thread", resolver):
            return await tool_executor("node-1")(state)

    def _big_tool(self):
        class _Big(_Recorder):
            async def run(self, args, context):
                return ToolResult(content="S" + "x" * 20_000 + "E")

        return _Big("big")

    async def test_oversized_result_spills_and_excerpt_keeps_head_and_tail(self):
        store = self._Store()
        state = _state([{"id": "1", "name": "big"}], ["big", "fs_read"])
        out = await self._run_with_store(state, [self._big_tool(), _Recorder("fs_read")], store)

        [key] = store.writes
        self.assertIn("/results/big_1.txt", key)
        self.assertEqual(len(store.writes[key]), 20_002)

        content = out["loop_messages"][1]["content"]
        self.assertLess(len(content), 9_000)
        self.assertTrue(content.startswith("S"))          # head kept
        self.assertTrue(content.endswith("E"))            # tail kept
        self.assertIn("characters omitted", content)
        self.assertIn('fs_read(path="results/big_1.txt"', content)
        self.assertEqual(out["loop_messages"][1]["tool_call_id"], "1")
        # The spilled file joins the run's fs index.
        self.assertEqual(out["scratch"]["fs_files"], {"results/big_1.txt": 20_002})

    async def test_spill_without_fs_read_enabled_does_not_advertise_it(self):
        store = self._Store()
        state = _state([{"id": "1", "name": "big"}], ["big"])
        out = await self._run_with_store(state, [self._big_tool()], store)

        self.assertNotIn("fs_read(", out["loop_messages"][1]["content"])

    async def test_failed_spill_still_truncates(self):
        store = self._Store(fail=True)
        state = _state([{"id": "1", "name": "big"}], ["big"])
        out = await self._run_with_store(state, [self._big_tool()], store)

        content = out["loop_messages"][1]["content"]
        self.assertLess(len(content), 9_000)
        self.assertIn("could not be saved", content)
        self.assertNotIn("fs_files", out["scratch"])

    async def test_small_results_are_untouched(self):
        store = self._Store()
        state = _state([{"id": "1", "name": "t"}], ["t"])
        out = await self._run_with_store(state, [_Recorder("t")], store)

        self.assertEqual(out["loop_messages"][1]["content"], "t ran")
        self.assertEqual(store.writes, {})


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
