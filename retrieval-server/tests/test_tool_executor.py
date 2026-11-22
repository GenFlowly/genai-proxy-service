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
from graph.lookup_pool import LookupPool
from graph.nodes.tool_executor import tool_executor
from graph_tools.base import GraphTool, Source, ToolContext, ToolResult


class _Recorder(GraphTool):
    """A tool that records the context it was handed."""

    def __init__(self, name, credential_ref=None, raises=None, sources=None, content=None):
        self.name = name
        self.description = f"stub {name}"
        self.parameters = {"type": "object", "properties": {}}
        self.credential_ref = credential_ref
        self._raises = raises
        self._sources = sources or []
        self._content = content
        self.seen_context: ToolContext | None = None
        self.seen_args: dict | None = None
        self.run_count = 0

    async def run(self, args: dict, context: ToolContext) -> ToolResult:
        self.run_count += 1
        self.seen_args = args
        self.seen_context = context
        if self._raises:
            raise self._raises
        return ToolResult(content=self._content or f"{self.name} ran", sources=self._sources)


def _state(calls, enabled):
    return {
        "customer_id": "cust-1",
        "tool_calls": calls,
        "builtin_tools": enabled,
        "generated_response": "thinking...",
    }


async def _run(state, tools, resolved=None, resolve_error=None, settings=None):
    """Execute the node with `tools` as the request's enabled set. `settings`
    maps credential_ref -> plain per-customer tool settings, riding the same
    resolution call as the credentials."""
    resolver = AsyncMock(return_value=(resolved or {}, settings or {}))
    if resolve_error:
        resolver = AsyncMock(side_effect=resolve_error)
    with patch.object(tool_executor_module, "tools_for", return_value=tools), \
            patch.object(tool_executor_module, "resolve_tool_credentials_and_settings") as sync_resolver, \
            patch.object(tool_executor_module.asyncio, "to_thread", resolver):
        sync_resolver.return_value = (resolved or {}, settings or {})
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
        resolver = AsyncMock(return_value=({"WEB_SEARCH": {"api_key": "k"}}, {}))
        with patch.object(tool_executor_module, "tools_for", return_value=[tool]), \
                patch.object(tool_executor_module, "resolve_tool_credentials_and_settings") as sync_resolver, \
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
    reads, and returns the {index,title,url,favicon?,published_date?} snapshot the streaming layer emits
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
        # The publish date rides with the numbered source for the client too.
        self.assertEqual(out["tool_sources"], [
            {"index": 1, "title": "A", "url": "https://a"},
            {"index": 2, "title": "B", "url": "https://b", "published_date": "2026-09-01"},
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

    async def test_content_markers_are_shifted_to_the_turn_global_numbering(self):
        # A tool whose content already cites its own sources with local 1..k
        # markers (spawn_agent returning a subagent report). Earlier rounds
        # set the base at 2, so the report's [1][2] must become [3][4] — while
        # a bracketed number beyond the tool's own source count stays put.
        state = _state([{"id": "1", "name": "spawn_agent"}], ["spawn_agent"])
        state["tool_sources"] = [
            {"index": 1, "title": "X", "url": "u1"},
            {"index": 2, "title": "Y", "url": "u2"},
        ]
        tool = _Recorder(
            "spawn_agent",
            content="PSE has an API [1]; WM too [2]. See RFC [7].",
            sources=[Source(title="PSE", url="https://pse"), Source(title="WM", url="https://wm")],
        )
        out = await _run(state, [tool])

        msg = out["loop_messages"][1]["content"]
        self.assertIn("PSE has an API [3]; WM too [4]. See RFC [7].", msg)
        self.assertIn("[3] PSE (https://pse)", msg)
        self.assertIn("[4] WM (https://wm)", msg)
        self.assertEqual(out["tool_sources"][-2:], [
            {"index": 3, "title": "PSE", "url": "https://pse"},
            {"index": 4, "title": "WM", "url": "https://wm"},
        ])

    async def test_content_markers_stay_put_when_the_tool_leads_the_turn(self):
        # No prior sources this turn → base 0 → local numbering IS the global
        # numbering; the content must come through byte-identical.
        tool = _Recorder(
            "spawn_agent",
            content="answer [1] and [2]",
            sources=[Source(title="A", url="https://a"), Source(title="B", url="https://b")],
        )
        out = await _run(_state([{"id": "1", "name": "spawn_agent"}], ["spawn_agent"]), [tool])
        self.assertIn("answer [1] and [2]", out["loop_messages"][1]["content"])

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
    trace entry (→ the activity log's tools step → proxy persistence)."""

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

        def put(self, key, data, content_type, tags=None):
            if self.fail:
                raise RuntimeError("s3 down")
            self.writes[key] = data
            self.tags = tags

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
        # Scratch carries the tag the bucket's lifecycle rule expires.
        self.assertEqual(store.tags, {"retention": "scratch"})

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


class SearchBudgetTests(unittest.IsolatedAsyncioTestCase):
    """Per-turn web_search budget: fan-out beyond the budget is answered with
    guidance instead of an API call; over-budget rounds keep exactly one
    "refine and retry" search; the running total rides scratch."""

    @staticmethod
    def _searches(n, start=1):
        return [{"id": str(i), "name": "web_search", "args": {"query": f"q{i}"}}
                for i in range(start, start + n)]

    async def test_fan_out_beyond_budget_is_skipped_with_guidance(self):
        tool = _Recorder("web_search")
        out = await _run(_state(self._searches(5), ["web_search"]), [tool])

        self.assertEqual(tool.run_count, 3)
        contents = [m["content"] for m in out["loop_messages"][1:]]
        self.assertEqual(contents[:3], ["web_search ran"] * 3)
        for skipped in contents[3:]:
            self.assertIn("Web search skipped", skipped)
            self.assertIn("ONE refined query", skipped)
        self.assertEqual(out["scratch"]["web_search_calls"], 3)
        # Skipped calls still answer their tool_call ids — no dangling pairs.
        self.assertEqual(len(contents), 5)

    async def test_over_budget_round_runs_one_grace_search_with_note(self):
        tool = _Recorder("web_search")
        state = _state(self._searches(2), ["web_search"])
        state["scratch"] = {"web_search_calls": 3}
        out = await _run(state, [tool])

        self.assertEqual(tool.run_count, 1)
        contents = [m["content"] for m in out["loop_messages"][1:]]
        self.assertIn("web_search ran", contents[0])
        self.assertIn("Consolidate", contents[0])  # the appended note
        self.assertIn("Web search skipped", contents[1])
        self.assertEqual(out["scratch"]["web_search_calls"], 4)

    async def test_round_crossing_the_boundary_gets_no_grace_search(self):
        # prior=2, budget=3: the first call lands within budget, and the round
        # gets NO grace — the model issued the rest before seeing any budget
        # message, so they are unrefined duplicates by construction.
        tool = _Recorder("web_search")
        state = _state(self._searches(3), ["web_search"])
        state["scratch"] = {"web_search_calls": 2}
        out = await _run(state, [tool])

        self.assertEqual(tool.run_count, 1)
        contents = [m["content"] for m in out["loop_messages"][1:]]
        self.assertEqual(contents[0], "web_search ran")  # within budget, no note
        self.assertIn("Web search skipped", contents[1])
        self.assertIn("Web search skipped", contents[2])
        self.assertEqual(out["scratch"]["web_search_calls"], 3)

    async def test_budget_is_configurable_via_node_config(self):
        tool = _Recorder("web_search")
        state = _state(self._searches(2), ["web_search"])
        state["node_configs"] = {"node-1": {"max_web_searches": 1}}
        out = await _run(state, [tool])

        self.assertEqual(tool.run_count, 1)
        self.assertEqual(out["scratch"]["web_search_calls"], 1)

    async def test_other_tools_are_never_budgeted(self):
        search = _Recorder("web_search")
        other = _Recorder("search_knowledge_base")
        state = _state(
            self._searches(1) + [{"id": "9", "name": "search_knowledge_base", "args": {}}],
            ["web_search", "search_knowledge_base"],
        )
        state["scratch"] = {"web_search_calls": 7}  # far over budget
        out = await _run(state, [search, other])

        self.assertEqual(other.run_count, 1)
        contents = [m["content"] for m in out["loop_messages"][1:]]
        self.assertEqual(contents[1], "search_knowledge_base ran")

    async def test_turn_without_searches_leaves_scratch_counter_untouched(self):
        out = await _run(_state([{"id": "1", "name": "t"}], ["t"]), [_Recorder("t")])
        self.assertNotIn("web_search_calls", out["scratch"])


class HardSearchCapTests(unittest.IsolatedAsyncioTestCase):
    """The vendor-style HARD ceiling (default 5): past it even the grace
    search is denied and the tool answers with a terminal message. Customer
    value comes from the WEB_SEARCH settings resolved with the credentials."""

    @staticmethod
    def _searches(n, start=1):
        return [{"id": str(i), "name": "web_search", "args": {"query": f"q{i}"}}
                for i in range(start, start + n)]

    async def test_default_hard_cap_denies_the_grace_search_at_five(self):
        tool = _Recorder("web_search")
        state = _state(self._searches(2), ["web_search"])
        state["scratch"] = {"web_search_calls": 5}
        out = await _run(state, [tool])

        self.assertEqual(tool.run_count, 0)  # no grace past the hard cap
        for content in [m["content"] for m in out["loop_messages"][1:]]:
            self.assertIn("no longer available this turn", content)
            self.assertIn("limit (5)", content)
        self.assertNotIn("web_search_calls", out["scratch"])  # nothing ran

    async def test_grace_still_runs_between_soft_budget_and_hard_cap(self):
        tool = _Recorder("web_search")
        state = _state(self._searches(1), ["web_search"])
        state["scratch"] = {"web_search_calls": 4}
        out = await _run(state, [tool])

        self.assertEqual(tool.run_count, 1)
        self.assertIn("Consolidate", out["loop_messages"][1]["content"])
        self.assertEqual(out["scratch"]["web_search_calls"], 5)

    async def test_customer_setting_overrides_the_default(self):
        # credential_ref makes resolution run, which is what carries settings.
        tool = _Recorder("web_search", credential_ref="WEB_SEARCH")
        state = _state(self._searches(3), ["web_search"])
        out = await _run(
            state, [tool],
            settings={"WEB_SEARCH": {"max_searches_per_turn": "2"}},
        )

        # Hard cap 2 undercuts the soft budget of 3: two run, the third is
        # terminal — never a refine-guidance skip.
        self.assertEqual(tool.run_count, 2)
        contents = [m["content"] for m in out["loop_messages"][1:]]
        self.assertIn("no longer available this turn", contents[2])
        self.assertEqual(out["scratch"]["web_search_calls"], 2)

    async def test_a_round_straddling_the_hard_cap_mixes_modes(self):
        tool = _Recorder("web_search")
        state = _state(self._searches(4), ["web_search"])
        state["scratch"] = {"web_search_calls": 4}
        out = await _run(state, [tool])

        # prior=4: one grace search reaches the cap of 5; the rest are terminal.
        self.assertEqual(tool.run_count, 1)
        contents = [m["content"] for m in out["loop_messages"][1:]]
        self.assertIn("Consolidate", contents[0])
        for content in contents[1:]:
            self.assertIn("no longer available this turn", content)

    async def test_malformed_customer_setting_falls_back_to_default(self):
        tool = _Recorder("web_search", credential_ref="WEB_SEARCH")
        state = _state(self._searches(1), ["web_search"])
        state["scratch"] = {"web_search_calls": 4}
        out = await _run(
            state, [tool],
            settings={"WEB_SEARCH": {"max_searches_per_turn": "lots"}},
        )

        self.assertEqual(tool.run_count, 1)  # default cap 5 still allows the grace
        self.assertEqual(out["scratch"]["web_search_calls"], 5)


if __name__ == "__main__":
    unittest.main()


class ActivityFactsTests(unittest.IsolatedAsyncioTestCase):
    """The facts each call records for the activity panel: identity, order,
    how the budget treated it, how long it took and what came back."""

    @staticmethod
    def _searches(n, start=1):
        return [{"id": f"call-{i}", "name": "web_search", "args": {"query": f"q{i}"}}
                for i in range(start, start + n)]

    async def test_each_call_records_identity_order_mode_and_result(self):
        tool = _Recorder("web_search", sources=[Source(title="A", url="https://a.example")],
                         content="Web search results for 'q1'.")
        out = await _run(_state(self._searches(1), ["web_search"]), [tool])

        call = out["trace"][0]["calls"][0]
        self.assertEqual(call["id"], "call-1")
        self.assertEqual(call["seq"], 1)
        self.assertEqual(call["mode"], "run")
        self.assertIsInstance(call["duration_ms"], int)
        self.assertGreaterEqual(call["duration_ms"], 0)
        self.assertEqual(call["result_count"], 1)
        self.assertEqual(call["result_excerpt"], "Web search results for 'q1'.")

    async def test_budget_modes_are_recorded_per_call(self):
        tool = _Recorder("web_search")
        out = await _run(_state(self._searches(5), ["web_search"]), [tool])

        calls = out["trace"][0]["calls"]
        self.assertEqual([c["mode"] for c in calls], ["run", "run", "run", "skip", "skip"])
        self.assertEqual([c["seq"] for c in calls], [1, 2, 3, 4, 5])
        self.assertEqual(calls[3]["duration_ms"], 0)
        self.assertTrue(calls[3]["result_excerpt"].startswith("Web search skipped"))
        self.assertEqual(out["trace"][0]["budget"], {"used": 3, "max": 5})

    async def test_calls_past_the_hard_cap_are_exhausted(self):
        state = _state(self._searches(2), ["web_search"])
        state["scratch"] = {"web_search_calls": 5}
        out = await _run(state, [_Recorder("web_search")])

        self.assertEqual([c["mode"] for c in out["trace"][0]["calls"]], ["exhausted", "exhausted"])
        self.assertEqual(out["trace"][0]["budget"], {"used": 5, "max": 5})

    async def test_no_budget_when_the_round_made_no_search(self):
        out = await _run(_state([{"id": "1", "name": "t"}], ["t"]), [_Recorder("t")])
        self.assertNotIn("budget", out["trace"][0])

    async def test_the_trace_no_longer_carries_flattened_summaries(self):
        out = await _run(_state(self._searches(1), ["web_search"]), [_Recorder("web_search")])
        self.assertEqual(set(out["trace"][0]), {"node", "calls", "budget"})

    async def test_icon_and_date_ride_with_each_numbered_source(self):
        tool = _Recorder("web_search", sources=[
            Source(title="A", url="https://a.example/x", published_date="2026-03-01",
                   favicon="https://a.example/favicon.ico"),
            Source(title="B", url="https://b.example/y"),
        ])
        out = await _run(_state(self._searches(1), ["web_search"]), [tool])

        expected = [
            {"index": 1, "title": "A", "url": "https://a.example/x",
             "favicon": "https://a.example/favicon.ico", "published_date": "2026-03-01"},
            {"index": 2, "title": "B", "url": "https://b.example/y"},
        ]
        self.assertEqual(out["trace"][0]["calls"][0]["sources"], expected)
        self.assertEqual(out["tool_sources"], expected)

    async def test_a_failed_call_has_an_error_and_no_result(self):
        tool = _Recorder("web_search", raises=RuntimeError("provider down"))
        out = await _run(_state(self._searches(1), ["web_search"]), [tool])

        call = out["trace"][0]["calls"][0]
        self.assertEqual(call["error"], "provider down")
        self.assertIsNone(call["result_count"])
        self.assertIsNone(call["result_excerpt"])

    async def test_every_finished_call_is_reported_live(self):
        reported = []

        async def capture(facts):
            reported.append(facts)

        tool = _Recorder("web_search", sources=[Source(title="A", url="https://a")])
        with patch.object(tool_executor_module, "report_call", capture):
            await _run(_state(self._searches(4), ["web_search"]), [tool])

        self.assertEqual(sorted(r["seq"] for r in reported), [1, 2, 3, 4])
        by_seq = {r["seq"]: r for r in reported}
        self.assertEqual(by_seq[1]["id"], "call-1")
        self.assertEqual(by_seq[1]["result_count"], 1)
        self.assertEqual(by_seq[4]["mode"], "skip")
        self.assertEqual(set(by_seq[1]), {"id", "seq", "name", "mode", "duration_ms", "result_count", "error"})


class LookupPoolIntegrationTests(unittest.IsolatedAsyncioTestCase):
    """Shareable tools route through the per-message lookup pool: a sibling
    run of the same turn gets the first run's results instead of executing;
    everything else — other tools, runs without a turn id — is untouched."""

    def setUp(self):
        patcher = patch.object(tool_executor_module, "lookup_pool", LookupPool())
        patcher.start()
        self.addCleanup(patcher.stop)

    @staticmethod
    def _search_state(query, run, turn="turn-1"):
        state = _state([{"id": "1", "name": "web_search", "args": {"query": query}}], ["web_search"])
        state["scratch"] = {"fs_namespace": run}
        state["turn_id"] = turn
        return state

    @staticmethod
    def _shareable_tool(**kw):
        tool = _Recorder("web_search", sources=[Source(title="T", url="https://x", content="c")], **kw)
        tool.shareable = True
        return tool

    async def test_sibling_run_is_served_from_the_pool(self):
        tool = self._shareable_tool()
        await _run(self._search_state("q a", "run-a"), [tool])
        out = await _run(self._search_state("q b", "run-b"), [tool])

        self.assertEqual(tool.run_count, 1)
        content = out["loop_messages"][1]["content"]
        self.assertIn("parallel run", content)
        self.assertIn("Your query was 'q b'", content)
        self.assertIn("[1] T (https://x)", content)  # rendered + numbered like a real result
        self.assertEqual(out["tool_sources"], [{"index": 1, "title": "T", "url": "https://x"}])
        self.assertEqual(out["trace"][0]["calls"][0]["details"]["pool"], "shared")
        # The run's own budget still counts the call it issued.
        self.assertEqual(out["scratch"]["web_search_calls"], 1)

    async def test_without_a_turn_id_every_run_searches(self):
        tool = self._shareable_tool()
        await _run(self._search_state("q a", "run-a", turn=None), [tool])
        await _run(self._search_state("q b", "run-b", turn=None), [tool])
        self.assertEqual(tool.run_count, 2)

    async def test_non_shareable_tools_never_touch_the_pool(self):
        tool = _Recorder("fs_read")
        with patch.object(tool_executor_module.lookup_pool, "execute", AsyncMock(side_effect=AssertionError)):
            state = _state([{"id": "1", "name": "fs_read", "args": {"path": "p"}}], ["fs_read"])
            state["turn_id"] = "turn-1"
            out = await _run(state, [tool])
        self.assertEqual(tool.run_count, 1)
        self.assertEqual(out["loop_messages"][1]["content"], "fs_read ran")

    async def test_pooled_calls_are_counted_apart_from_executions(self):
        tool = self._shareable_tool()
        with patch.object(tool_executor_module, "count") as count:
            await _run(self._search_state("q a", "run-a"), [tool])
            await _run(self._search_state("q b", "run-b"), [tool])
        statuses = [c.kwargs["status"] for c in count.call_args_list
                    if c.args[0] == "tool_execution_total" and c.kwargs.get("tool") == "web_search"]
        self.assertEqual(statuses, ["ok", "pooled"])

    async def test_a_failing_shared_tool_still_isolates_the_error(self):
        tool = self._shareable_tool(raises=RuntimeError("boom"))
        out = await _run(self._search_state("q a", "run-a"), [tool])
        self.assertIn("Error executing web_search: boom", out["loop_messages"][1]["content"])
