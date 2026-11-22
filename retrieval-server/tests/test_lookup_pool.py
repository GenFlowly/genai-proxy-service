"""
Unit tests for graph.lookup_pool — per-message sharing of lookup results
between the parallel per-model runs of one turn.

Run with `python -m unittest tests.test_lookup_pool`.
"""
import asyncio
import threading
import unittest
from unittest.mock import patch

import graph.lookup_pool as lookup_pool_module
from graph.lookup_pool import (
    OUTCOME_BYPASSED, OUTCOME_DEDUPLICATED, OUTCOME_EXECUTED, OUTCOME_FALLBACK,
    OUTCOME_SHARED, LookupPool, args_key,
)
from graph_tools.base import Source, ToolResult

TOOL = "web_search"


def _result(*urls):
    return ToolResult(
        content="ran",
        sources=[Source(title=f"T {u}", url=f"https://{u}", content=f"about {u}") for u in urls],
    )


class _Executor:
    """A stand-in for tool.run: counts calls, optionally blocks on a gate or
    raises, and returns a fixed result."""

    def __init__(self, result=None, gate: asyncio.Event | None = None, raises=None):
        self.result = result if result is not None else _result("a", "b")
        self.gate = gate
        self.raises = raises
        self.calls = 0

    async def __call__(self):
        self.calls += 1
        if self.gate is not None:
            await self.gate.wait()
        if self.raises:
            raise self.raises
        return self.result


class LookupPoolTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.metrics = []
        patcher = patch.object(
            lookup_pool_module, "count",
            side_effect=lambda name, value=1, **dims: self.metrics.append((name, dims)),
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        observe = patch.object(lookup_pool_module, "observe")
        observe.start()
        self.addCleanup(observe.stop)
        self.pool = LookupPool(wait_timeout=1.0)

    async def _call(self, run, query, executor, turn="turn-1", pool=None):
        return await (pool or self.pool).execute(turn, TOOL, run, {"query": query}, executor)

    def _statuses(self):
        return [d["status"] for n, d in self.metrics if n == "lookup_pool_total"]

    async def test_no_turn_id_bypasses_the_pool(self):
        ex = _Executor()
        result, outcome = await self._call("run-a", "q1", ex, turn=None)
        self.assertEqual(outcome, OUTCOME_BYPASSED)
        self.assertIs(result, ex.result)
        self.assertEqual(ex.calls, 1)

    async def test_first_run_executes_and_a_sibling_first_call_shares(self):
        a, b = _Executor(_result("x", "y")), _Executor(_result("z"))
        result_a, outcome_a = await self._call("run-a", "latest iPhone changes", a)
        result_b, outcome_b = await self._call("run-b", "new iPhone features", b)

        self.assertEqual((outcome_a, outcome_b), (OUTCOME_EXECUTED, OUTCOME_SHARED))
        self.assertIs(result_a, a.result)
        self.assertEqual(b.calls, 0)
        self.assertEqual([s.url for s in result_b.sources], ["https://x", "https://y"])
        self.assertIn("parallel run", result_b.content)
        self.assertIn("'latest iPhone changes'", result_b.content)
        self.assertIn("Your query was 'new iPhone features'", result_b.content)
        self.assertIn("ONE refined query", result_b.content)
        self.assertEqual(result_b.details, {"pool": OUTCOME_SHARED, "queries": ["latest iPhone changes"]})
        self.assertEqual(self._statuses(), [OUTCOME_EXECUTED, OUTCOME_SHARED])

    async def test_identical_query_is_deduplicated_regardless_of_run(self):
        a, again, b = _Executor(), _Executor(), _Executor()
        await self._call("run-a", "Q1", a)
        result_again, outcome_again = await self._call("run-a", "  q1 ", again)
        # run-b's first call: an exact match beats the general share.
        result_b, outcome_b = await self._call("run-b", "q1", b)

        self.assertEqual((outcome_again, outcome_b), (OUTCOME_DEDUPLICATED, OUTCOME_DEDUPLICATED))
        self.assertEqual((again.calls, b.calls), (0, 0))
        self.assertIn("identical request, not re-run", result_again.content)
        self.assertEqual([s.url for s in result_b.sources], ["https://a", "https://b"])

    async def test_later_calls_of_a_served_run_execute_and_join_the_pool(self):
        a, b_first, b_refine, c = _Executor(_result("x")), _Executor(), _Executor(_result("r")), _Executor()
        await self._call("run-a", "q1", a)
        _, outcome_b1 = await self._call("run-b", "q2", b_first)
        _, outcome_b2 = await self._call("run-b", "refined", b_refine)
        result_c, outcome_c = await self._call("run-c", "q3", c)

        self.assertEqual((outcome_b1, outcome_b2), (OUTCOME_SHARED, OUTCOME_EXECUTED))
        self.assertEqual(b_refine.calls, 1)
        # run-c's first call sees both real fetches, merged.
        self.assertEqual(outcome_c, OUTCOME_SHARED)
        self.assertEqual([s.url for s in result_c.sources], ["https://x", "https://r"])
        self.assertEqual(result_c.details["queries"], ["q1", "refined"])

    async def test_a_sibling_waits_for_an_in_flight_fetch(self):
        gate = asyncio.Event()
        a, b = _Executor(_result("x"), gate=gate), _Executor()
        task_a = asyncio.create_task(self._call("run-a", "q1", a))
        await asyncio.sleep(0)  # run-a registers its fetch and blocks
        task_b = asyncio.create_task(self._call("run-b", "q2", b))
        await asyncio.sleep(0.01)
        self.assertFalse(task_b.done())

        gate.set()
        (_, outcome_a), (result_b, outcome_b) = await asyncio.gather(task_a, task_b)
        self.assertEqual((outcome_a, outcome_b), (OUTCOME_EXECUTED, OUTCOME_SHARED))
        self.assertEqual(b.calls, 0)
        self.assertEqual([s.url for s in result_b.sources], ["https://x"])

    async def test_failed_sibling_fetch_is_forgotten_and_the_waiter_falls_back(self):
        gate = asyncio.Event()
        a = _Executor(gate=gate, raises=RuntimeError("tavily down"))
        b, c = _Executor(_result("b")), _Executor()
        task_a = asyncio.create_task(self._call("run-a", "q1", a))
        await asyncio.sleep(0)
        task_b = asyncio.create_task(self._call("run-b", "q2", b))
        await asyncio.sleep(0)
        gate.set()
        with self.assertRaises(RuntimeError):
            await task_a
        result_b, outcome_b = await task_b
        self.assertEqual(outcome_b, OUTCOME_FALLBACK)
        self.assertEqual(b.calls, 1)
        self.assertIs(result_b, b.result)
        # The failed fetch is gone: a repeat of its query is not "deduplicated"
        # against a failure, it shares the one good result instead.
        result_c, outcome_c = await self._call("run-c", "q1", c)
        self.assertEqual(outcome_c, OUTCOME_SHARED)
        self.assertEqual([s.url for s in result_c.sources], ["https://b"])

    async def test_a_result_without_sources_is_never_shared(self):
        a, b = _Executor(ToolResult(content="No web results found")), _Executor()
        await self._call("run-a", "q1", a)
        result_b, outcome_b = await self._call("run-b", "q2", b)
        self.assertEqual(outcome_b, OUTCOME_FALLBACK)
        self.assertEqual(b.calls, 1)
        self.assertIs(result_b, b.result)

    async def test_shared_sources_are_merged_in_order_without_duplicate_urls(self):
        a1, a2, b = _Executor(_result("x", "y")), _Executor(_result("y", "z")), _Executor()
        await asyncio.gather(self._call("run-a", "q1", a1), self._call("run-a", "q2", a2))
        result_b, outcome_b = await self._call("run-b", "q3", b)
        self.assertEqual(outcome_b, OUTCOME_SHARED)
        self.assertEqual([s.url for s in result_b.sources], ["https://x", "https://y", "https://z"])
        self.assertEqual(result_b.details["queries"], ["q1", "q2"])

    async def test_waiting_gives_up_after_the_timeout_and_falls_back(self):
        pool = LookupPool(wait_timeout=0.05)
        gate = asyncio.Event()
        a, b = _Executor(gate=gate), _Executor(_result("b"))
        task_a = asyncio.create_task(self._call("run-a", "q1", a, pool=pool))
        await asyncio.sleep(0)
        result_b, outcome_b = await self._call("run-b", "q2", b, pool=pool)
        self.assertEqual(outcome_b, OUTCOME_FALLBACK)
        self.assertIs(result_b, b.result)
        # The abandoned wait must not have cancelled the sibling's fetch.
        gate.set()
        _, outcome_a = await task_a
        self.assertEqual(outcome_a, OUTCOME_EXECUTED)

    async def test_waits_across_event_loops(self):
        registered, release = threading.Event(), threading.Event()
        a_calls = []

        async def exec_a():
            a_calls.append(1)
            registered.set()
            await asyncio.to_thread(release.wait)
            return _result("x")

        outcome_a = []

        def other_loop():
            outcome_a.append(asyncio.run(self._call("run-a", "q1", exec_a)))

        thread = threading.Thread(target=other_loop)
        thread.start()
        self.assertTrue(registered.wait(2.0))
        b = _Executor()
        task_b = asyncio.create_task(self._call("run-b", "q2", b))
        await asyncio.sleep(0.02)
        self.assertFalse(task_b.done())
        release.set()
        result_b, outcome_b = await task_b
        thread.join(2.0)
        self.assertEqual(outcome_b, OUTCOME_SHARED)
        self.assertEqual(b.calls, 0)
        self.assertEqual([s.url for s in result_b.sources], ["https://x"])
        self.assertEqual(outcome_a[0][1], OUTCOME_EXECUTED)

    async def test_entries_expire_with_the_ttl(self):
        pool = LookupPool(ttl_seconds=0.01)
        a, b = _Executor(), _Executor()
        await self._call("run-a", "q1", a, pool=pool)
        await asyncio.sleep(0.03)
        _, outcome_b = await self._call("run-b", "q2", b, pool=pool)
        self.assertEqual(outcome_b, OUTCOME_EXECUTED)
        self.assertEqual(b.calls, 1)

    async def test_turns_and_tools_are_isolated(self):
        a, b, c = _Executor(), _Executor(), _Executor()
        await self._call("run-a", "q1", a, turn="turn-1")
        _, outcome_other_turn = await self._call("run-b", "q2", b, turn="turn-2")
        _, outcome_other_tool = await self.pool.execute("turn-1", "search_knowledge_base", "run-b", {"query": "q1"}, c)
        self.assertEqual((outcome_other_turn, outcome_other_tool), (OUTCOME_EXECUTED, OUTCOME_EXECUTED))

    def test_args_key_ignores_order_case_and_whitespace(self):
        self.assertEqual(
            args_key({"query": " Latest  iPhone ", "topic": "news", "include_domains": ["b.com", "A.com"]}),
            args_key({"include_domains": ["a.com", "B.com"], "topic": "news", "query": "latest iphone"}),
        )
        self.assertNotEqual(args_key({"query": "q", "topic": "news"}), args_key({"query": "q"}))

    def test_args_key_ignores_the_explanatory_purpose(self):
        # Two runs that search the same thing for different stated reasons still
        # fetch the same results, so the pool must treat them as one lookup.
        self.assertEqual(
            args_key({"query": "q", "purpose": "Check the price."}),
            args_key({"query": "q", "purpose": "Compare vendors."}),
        )


if __name__ == "__main__":
    unittest.main()
