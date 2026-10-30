"""
Unit tests for graph.instruction_loader — instruction references resolved to
prompt text with a pinned (immutable, no-TTL) and a latest (short-TTL) cache.

Pinned here:

  * a pinned (id, version) is read from DDB once, then served from cache
  * "latest" is served from cache within the TTL and reloaded after invalidate
  * a missing instruction is negative-cached: one DDB query per TTL window,
    not one per turn
  * both caches stay bounded no matter how many instructions are touched
  * resolution failures return None, never raise into the caller
"""
import unittest
from unittest.mock import MagicMock, patch

from graph import instruction_loader
from graph.instruction_loader import get_instruction_text, invalidate_instruction_cache


def _ddb(get_item_content=None, query_content=None):
    table = MagicMock()
    table.get_item.return_value = {
        "Item": {"instructions": get_item_content} if get_item_content is not None else None
    }
    table.query.return_value = {
        "Items": [{"instructions": query_content}] if query_content is not None else []
    }
    db = MagicMock()
    db.Table.return_value = table
    return db, table


class PinnedInstructionTests(unittest.TestCase):
    def setUp(self):
        instruction_loader._pinned_cache.clear()
        instruction_loader._latest_cache.clear()

    def test_pinned_version_is_cached_after_the_first_read(self):
        db, table = _ddb(get_item_content="You are concise.")
        with patch.object(instruction_loader, "_get_dynamodb", return_value=db):
            self.assertEqual(get_instruction_text("inst-1", 3), "You are concise.")
            self.assertEqual(get_instruction_text("inst-1", 3), "You are concise.")
        table.get_item.assert_called_once()

    def test_a_missing_pinned_version_is_not_cached(self):
        db, table = _ddb(get_item_content=None)
        with patch.object(instruction_loader, "_get_dynamodb", return_value=db):
            self.assertIsNone(get_instruction_text("inst-1", 3))
            self.assertIsNone(get_instruction_text("inst-1", 3))
        self.assertEqual(table.get_item.call_count, 2)

    def test_pinned_cache_never_grows_past_its_bound(self):
        db, _ = _ddb(get_item_content="text")
        with patch.object(instruction_loader, "_get_dynamodb", return_value=db):
            for i in range(instruction_loader._PINNED_CACHE_MAX_SIZE + 50):
                get_instruction_text(f"inst-{i}", 1)
        self.assertEqual(
            len(instruction_loader._pinned_cache),
            instruction_loader._PINNED_CACHE_MAX_SIZE,
        )


class LatestInstructionTests(unittest.TestCase):
    def setUp(self):
        instruction_loader._pinned_cache.clear()
        instruction_loader._latest_cache.clear()

    def test_latest_is_served_from_cache_within_the_ttl(self):
        db, table = _ddb(query_content="You are concise.")
        with patch.object(instruction_loader, "_get_dynamodb", return_value=db):
            self.assertEqual(get_instruction_text("inst-1"), "You are concise.")
            self.assertEqual(get_instruction_text("inst-1"), "You are concise.")
        table.query.assert_called_once()

    def test_invalidate_forces_a_reload(self):
        db, table = _ddb(query_content="v1")
        with patch.object(instruction_loader, "_get_dynamodb", return_value=db):
            get_instruction_text("inst-1")
            invalidate_instruction_cache("inst-1")
            get_instruction_text("inst-1")
        self.assertEqual(table.query.call_count, 2)

    def test_invalidate_all_clears_every_entry(self):
        db, table = _ddb(query_content="v1")
        with patch.object(instruction_loader, "_get_dynamodb", return_value=db):
            get_instruction_text("inst-1")
            get_instruction_text("inst-2")
            invalidate_instruction_cache()
            get_instruction_text("inst-1")
        self.assertEqual(table.query.call_count, 3)

    def test_a_missing_instruction_is_negative_cached(self):
        db, table = _ddb(query_content=None)
        with patch.object(instruction_loader, "_get_dynamodb", return_value=db):
            self.assertIsNone(get_instruction_text("inst-gone"))
            self.assertIsNone(get_instruction_text("inst-gone"))
        table.query.assert_called_once()

    def test_latest_cache_never_grows_past_its_bound(self):
        db, _ = _ddb(query_content="text")
        with patch.object(instruction_loader, "_get_dynamodb", return_value=db):
            for i in range(instruction_loader._LATEST_CACHE_MAX_SIZE + 50):
                get_instruction_text(f"inst-{i}")
        self.assertEqual(
            len(instruction_loader._latest_cache),
            instruction_loader._LATEST_CACHE_MAX_SIZE,
        )

    def test_resolution_failure_returns_none(self):
        db, table = _ddb()
        table.query.side_effect = RuntimeError("ddb down")
        with patch.object(instruction_loader, "_get_dynamodb", return_value=db):
            self.assertIsNone(get_instruction_text("inst-1"))


class EmptyReferenceTests(unittest.TestCase):
    def test_empty_id_resolves_to_none_without_touching_ddb(self):
        db = MagicMock()
        with patch.object(instruction_loader, "_get_dynamodb", db):
            self.assertIsNone(get_instruction_text(""))
        db.assert_not_called()


if __name__ == "__main__":
    unittest.main()
