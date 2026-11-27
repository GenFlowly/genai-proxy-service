"""Unit tests for graph/attachment_cache.py: byte bound, shared objects charged
once, idle expiry, and single-flight preparation."""
import asyncio
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import graph.attachment_cache as attachment_cache
from graph.attachment_cache import AttachmentCache


class BoundTests(unittest.TestCase):
    def test_bounded_by_bytes_least_recent_first(self):
        cache = AttachmentCache(max_bytes=10)
        cache.put("a", "AAAA", cost=4)
        cache.put("b", "BBBB", cost=4)
        self.assertEqual(cache.get("a"), "AAAA")  # now most recent
        cache.put("c", "CCCC", cost=4)  # 12 > 10: evicts b
        self.assertIsNone(cache.get("b"))
        self.assertEqual(cache.get("a"), "AAAA")
        self.assertEqual(cache.size_bytes, 8)

    def test_a_value_larger_than_the_cache_is_not_kept(self):
        cache = AttachmentCache(max_bytes=10)
        cache.put("huge", "X" * 11, cost=11)
        self.assertIsNone(cache.get("huge"))
        self.assertEqual(cache.size_bytes, 0)

    def test_one_object_under_several_keys_is_charged_once(self):
        cache = AttachmentCache(max_bytes=10)
        shared = "S" * 6
        cache.put(("image", "k", 1), shared, cost=6)
        cache.put(("image-passthrough", "k"), shared, cost=6)
        self.assertEqual(cache.size_bytes, 6)
        cache.put("other", "OOOO", cost=4)  # 10: still fits
        self.assertIs(cache.get(("image", "k", 1)), shared)
        # 11 > 10: dropping the least recent key frees nothing while the other
        # key still holds the object, so the next least recent goes too.
        cache.put("more", "M", cost=1)
        self.assertIsNone(cache.get(("image-passthrough", "k")))
        self.assertIsNone(cache.get("other"))
        self.assertIs(cache.get(("image", "k", 1)), shared)
        self.assertEqual(cache.size_bytes, 7)

    def test_replacing_a_key_releases_its_old_value(self):
        cache = AttachmentCache(max_bytes=100)
        cache.put("k", "old" * 3, cost=9)
        cache.put("k", "new", cost=3)
        self.assertEqual(cache.get("k"), "new")
        self.assertEqual(cache.size_bytes, 3)


class IdleExpiryTests(unittest.TestCase):
    def test_entries_expire_once_idle_and_use_refreshes_them(self):
        cache = AttachmentCache(max_bytes=100)
        clock = [1000.0]
        with patch.object(attachment_cache.time, "monotonic", lambda: clock[0]):
            cache.put("doc", "D" * 10, cost=10, idle_ttl_s=300)
            cache.put("img", "I" * 10, cost=10)
            clock[0] += 200
            self.assertIsNotNone(cache.get("doc"))  # used: idle again from here
            clock[0] += 200
            self.assertIsNotNone(cache.get("doc"))
            clock[0] += 301
            cache.purge_expired()
            self.assertIsNone(cache.get("doc"))
            self.assertIsNotNone(cache.get("img"))  # no expiry
            self.assertEqual(cache.size_bytes, 10)


class SingleFlightTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.pool = ThreadPoolExecutor(max_workers=2)
        self.addCleanup(self.pool.shutdown, wait=True)
        counted = patch.object(attachment_cache, "count")
        self.count = counted.start()
        self.addCleanup(counted.stop)

    async def test_concurrent_callers_share_one_preparation_and_one_object(self):
        cache = AttachmentCache(max_bytes=1000)
        release = threading.Event()
        calls = []

        def prepare():
            calls.append(1)
            release.wait(5)
            return "V" * 50

        waiting = [asyncio.ensure_future(cache.get_or_prepare("k", prepare, self.pool, cost=len, data_type="image"))
                   for _ in range(3)]
        await asyncio.sleep(0.05)
        release.set()
        values = await asyncio.gather(*waiting)
        self.assertEqual(len(calls), 1)
        self.assertTrue(all(v is values[0] for v in values))
        statuses = sorted(c.kwargs["status"] for c in self.count.call_args_list)
        self.assertEqual(statuses, ["joined", "joined", "prepared"])
        self.assertIs(await cache.get_or_prepare("k", prepare, self.pool, cost=len, data_type="image"), values[0])
        self.assertEqual(self.count.call_args.kwargs["status"], "hit")

    async def test_a_failure_reaches_every_caller_and_is_not_cached(self):
        cache = AttachmentCache(max_bytes=1000)
        release = threading.Event()

        def failing():
            release.wait(5)
            raise ValueError("unreadable")

        waiting = [asyncio.ensure_future(cache.get_or_prepare("k", failing, self.pool, cost=len, data_type="pdf"))
                   for _ in range(2)]
        await asyncio.sleep(0.05)
        release.set()
        results = await asyncio.gather(*waiting, return_exceptions=True)
        self.assertTrue(all(isinstance(r, ValueError) for r in results))
        self.assertEqual(await cache.get_or_prepare("k", lambda: "ok", self.pool, cost=len, data_type="pdf"), "ok")

    async def test_a_cancelled_caller_does_not_cancel_the_shared_preparation(self):
        cache = AttachmentCache(max_bytes=1000)
        release = threading.Event()

        def prepare():
            release.wait(5)
            return "V"

        first = asyncio.ensure_future(cache.get_or_prepare("k", prepare, self.pool, cost=len, data_type="image"))
        second = asyncio.ensure_future(cache.get_or_prepare("k", prepare, self.pool, cost=len, data_type="image"))
        await asyncio.sleep(0.05)
        first.cancel()  # the user's Stop on one vendor
        release.set()
        self.assertEqual(await second, "V")
        with self.assertRaises(asyncio.CancelledError):
            await first
        self.assertEqual(cache.get("k"), "V")


if __name__ == "__main__":
    unittest.main()
