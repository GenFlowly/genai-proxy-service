"""
Unit tests for graph.bounded_cache — the bounded mapping behind the
module-level loader caches.

Pinned here:

  * the LRU bound: inserts past max_size evict the least recently USED key
    (a get refreshes recency), never grow the cache
  * TTL expiry REMOVES entries — len shrinks — instead of leaving them as
    stale values, which was the leak the cache exists to stop
  * pop/clear semantics match dict.pop(key, default) / dict.clear()
  * a stored None is distinguishable from a missing key via get's default
"""
import time
import unittest

from graph.bounded_cache import BoundedCache


class LruBoundTests(unittest.TestCase):
    def test_insert_past_max_size_evicts_least_recently_used(self):
        cache = BoundedCache(3)
        cache.set("a", 1)
        cache.set("b", 2)
        cache.set("c", 3)
        cache.get("a")  # refreshes "a" — "b" becomes the LRU entry
        cache.set("d", 4)

        self.assertEqual(len(cache), 3)
        self.assertIsNone(cache.get("b"))
        self.assertEqual(cache.get("a"), 1)
        self.assertEqual(cache.get("c"), 3)
        self.assertEqual(cache.get("d"), 4)

    def test_overwriting_a_key_does_not_evict(self):
        cache = BoundedCache(2)
        cache.set("a", 1)
        cache.set("b", 2)
        cache.set("a", 10)

        self.assertEqual(len(cache), 2)
        self.assertEqual(cache.get("a"), 10)
        self.assertEqual(cache.get("b"), 2)

    def test_max_size_must_be_positive(self):
        with self.assertRaises(ValueError):
            BoundedCache(0)


class TtlTests(unittest.TestCase):
    def test_expired_entries_are_removed_not_served(self):
        cache = BoundedCache(8, ttl_seconds=0.05)
        cache.set("a", 1)
        cache.set("b", 2)
        self.assertEqual(cache.get("a"), 1)
        self.assertEqual(len(cache), 2)

        time.sleep(0.06)
        self.assertIsNone(cache.get("a"))
        # len purges too — both entries are gone, not lingering as stale
        self.assertEqual(len(cache), 0)
        self.assertNotIn("b", cache)

    def test_insert_purges_expired_entries(self):
        cache = BoundedCache(8, ttl_seconds=0.05)
        cache.set("a", 1)
        time.sleep(0.06)
        cache.set("b", 2)
        self.assertEqual(len(cache), 1)
        self.assertEqual(cache.get("b"), 2)

    def test_fresh_entries_are_served_within_the_ttl(self):
        cache = BoundedCache(8, ttl_seconds=60)
        cache.set("a", 1)
        self.assertEqual(cache.get("a"), 1)

    def test_no_ttl_means_entries_only_leave_via_lru_pop_or_clear(self):
        cache = BoundedCache(8)
        cache.set("a", 1)
        time.sleep(0.02)
        self.assertEqual(cache.get("a"), 1)


class RemovalTests(unittest.TestCase):
    def test_pop_returns_the_value_and_removes_the_entry(self):
        cache = BoundedCache(8)
        cache.set("a", 1)
        self.assertEqual(cache.pop("a", None), 1)
        self.assertIsNone(cache.get("a"))
        self.assertEqual(cache.pop("a", None), None)
        self.assertEqual(cache.pop("missing", "fallback"), "fallback")

    def test_pop_of_an_expired_entry_returns_the_default(self):
        cache = BoundedCache(8, ttl_seconds=0.05)
        cache.set("a", 1)
        time.sleep(0.06)
        self.assertIsNone(cache.pop("a", None))

    def test_clear_empties_the_cache(self):
        cache = BoundedCache(8)
        cache.set("a", 1)
        cache.set("b", 2)
        cache.clear()
        self.assertEqual(len(cache), 0)
        self.assertIsNone(cache.get("a"))


class NoneVsMissingTests(unittest.TestCase):
    def test_a_stored_none_is_distinguishable_via_a_sentinel_default(self):
        cache = BoundedCache(8)
        cache.set("negative", None)
        sentinel = object()
        self.assertIsNone(cache.get("negative", sentinel))
        self.assertIs(cache.get("missing", sentinel), sentinel)
        self.assertIn("negative", cache)
        self.assertNotIn("missing", cache)


if __name__ == "__main__":
    unittest.main()
