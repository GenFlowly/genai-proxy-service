"""Unit tests for graph/allocator.py: what a release does, and how run-end
releases coalesce."""
import asyncio
import unittest
from unittest.mock import MagicMock, patch

import graph.allocator as allocator


class ReleaseTests(unittest.TestCase):
    def test_collects_garbage_then_trims_and_reports_what_it_gave_back(self):
        order = []
        trim = MagicMock(side_effect=lambda pad: order.append("trim"))
        rss = iter([500 * 2**20, 420 * 2**20])
        with patch.object(allocator.gc, "collect", side_effect=lambda: order.append("collect")), \
                patch.object(allocator, "_malloc_trim", trim), \
                patch.object(allocator, "_rss_bytes", lambda: next(rss)), \
                patch.object(allocator, "count") as counted, \
                patch.object(allocator, "observe") as observed:
            released = allocator.release("run_end")
        self.assertEqual(order, ["collect", "trim"])  # freed objects first, then their pages
        trim.assert_called_once_with(0)
        self.assertEqual(released, 80 * 2**20)
        counted.assert_called_once_with("memory_released_bytes_total", 80 * 2**20, operation="run_end")
        self.assertEqual(observed.call_args.args[0], "memory_release_duration_seconds")

    def test_without_glibc_or_proc_it_still_collects(self):
        with patch.object(allocator, "_malloc_trim", None), \
                patch.object(allocator, "_rss_bytes", lambda: None), \
                patch.object(allocator.gc, "collect") as collect, \
                patch.object(allocator, "count"), patch.object(allocator, "observe"):
            self.assertEqual(allocator.release("periodic"), 0)
        collect.assert_called_once()


class ReleaseSoonTests(unittest.IsolatedAsyncioTestCase):
    async def test_the_runs_of_one_turn_share_one_release(self):
        with patch.object(allocator, "RUN_END_DELAY_SEC", 0.02), \
                patch.object(allocator, "release") as release:
            for _ in range(3):
                allocator.release_soon()
            await asyncio.sleep(0.1)
            release.assert_called_once_with("run_end")
            allocator.release_soon()  # a later turn schedules again
            await asyncio.sleep(0.1)
        self.assertEqual(release.call_count, 2)

    async def _periodic(self, activity: bool, dropped: int):
        calls = []
        with patch.object(allocator, "PERIODIC_SEC", 0.01), \
                patch.object(allocator, "_activity", activity), \
                patch.object(allocator, "release", side_effect=lambda op: calls.append(op)):
            task = asyncio.ensure_future(allocator.release_periodically(lambda: calls.append("purge") or dropped))
            await asyncio.sleep(0.05)
            task.cancel()
        return calls

    async def test_periodic_release_follows_requests(self):
        calls = await self._periodic(activity=True, dropped=0)
        self.assertEqual(calls[:2], ["purge", "periodic"])

    async def test_periodic_release_follows_dropped_attachments(self):
        calls = await self._periodic(activity=False, dropped=2)
        self.assertIn("periodic", calls)

    async def test_an_idle_process_is_not_paused(self):
        calls = await self._periodic(activity=False, dropped=0)
        self.assertNotIn("periodic", calls)
        self.assertIn("purge", calls)

    def test_a_release_clears_the_activity_mark(self):
        allocator.note_activity()
        with patch.object(allocator.gc, "collect"), patch.object(allocator, "_malloc_trim", None), \
                patch.object(allocator, "count"), patch.object(allocator, "observe"):
            allocator.release("run_end")
        self.assertFalse(allocator._activity)


if __name__ == "__main__":
    unittest.main()
