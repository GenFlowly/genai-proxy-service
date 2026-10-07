"""
Unit tests for loop-message compaction (graph.nodes.llm_node).

Run with `python -m unittest tests.test_compaction`.

The invariants that keep long agent loops both bounded and vendor-legal:
whole rounds fold as a unit (tool_call_id pairing in what remains is intact
by construction), the fold is pinned in scratch so it happens once per
threshold crossing, and a failed summarization degrades to clipping instead
of crashing the turn.
"""
import unittest
from unittest.mock import AsyncMock, patch

import graph.nodes.llm_node as llm_node_module
from graph.nodes.llm_node import _SUMMARY_PREFIX, _compact_loop_messages


def _round(n: int, result_size: int = 2000) -> list[dict]:
    return [
        {"role": "assistant", "content": f"searching {n}",
         "tool_calls": [{"id": f"call-{n}", "name": "web_search", "args": {"q": str(n)}}]},
        {"role": "tool", "tool_call_id": f"call-{n}", "content": "x" * result_size},
    ]


def _state(scratch=None) -> dict:
    return {
        "customer_id": "cust-1",
        "llm_provider": "openai",
        "llm_model": "gpt-test",
        "llm_credentials": {},
        "scratch": scratch or {},
    }


class CompactionTests(unittest.IsolatedAsyncioTestCase):
    async def test_below_threshold_replays_untouched(self):
        msgs = _round(1) + _round(2)
        replay, scratch, usage = await _compact_loop_messages(
            _state(), {"compaction_threshold_tokens": 100_000}, msgs, False
        )
        self.assertEqual(replay, msgs)
        self.assertEqual(scratch, {})
        self.assertIsNone(usage)

    async def test_over_threshold_folds_older_rounds_keeps_newest_verbatim(self):
        msgs = _round(1) + _round(2) + _round(3)
        summarize = AsyncMock(return_value=("facts so far", {"total_tokens": 50,
                                                            "input_tokens": 40, "output_tokens": 10}))
        with patch.object(llm_node_module, "_summarize_for_compaction", summarize):
            replay, scratch, usage = await _compact_loop_messages(
                _state(), {"compaction_threshold_tokens": 1}, msgs, False
            )

        # Summary first, then the NEWEST round intact — assistant with its
        # tool_calls immediately answered by its matching tool message.
        self.assertTrue(replay[0]["content"].startswith(_SUMMARY_PREFIX))
        self.assertEqual(replay[1]["content"], "searching 3")
        self.assertEqual(replay[1]["tool_calls"][0]["id"], "call-3")
        self.assertEqual(replay[2]["tool_call_id"], "call-3")
        self.assertEqual(len(replay), 3)
        # The fold is pinned: 4 messages (rounds 1-2) summarized.
        self.assertEqual(scratch["compaction"]["upto"], 4)
        self.assertEqual(scratch["compaction"]["summary"], "facts so far")
        self.assertEqual(usage["total_tokens"], 50)

    async def test_pinned_fold_is_reused_not_recomputed(self):
        msgs = _round(1) + _round(2) + _round(3, result_size=50)
        summarize = AsyncMock()
        with patch.object(llm_node_module, "_summarize_for_compaction", summarize):
            replay, scratch, _ = await _compact_loop_messages(
                _state(scratch={"compaction": {"summary": "old facts", "upto": 4}}),
                {"compaction_threshold_tokens": 100_000}, msgs, False,
            )

        summarize.assert_not_awaited()
        self.assertEqual(scratch, {})
        self.assertTrue(replay[0]["content"].endswith("old facts"))
        # Only the unfolded tail replays after the summary.
        self.assertEqual(replay[1]["content"], "searching 3")

    async def test_summarization_failure_degrades_to_clipping_and_retries_later(self):
        msgs = _round(1, result_size=3000) + _round(2, result_size=100)
        summarize = AsyncMock(side_effect=RuntimeError("vendor down"))
        with patch.object(llm_node_module, "_summarize_for_compaction", summarize):
            replay, scratch, usage = await _compact_loop_messages(
                _state(), {"compaction_threshold_tokens": 1}, msgs, False
            )

        # No fold pinned → retried next iteration; old tool result clipped,
        # every message (and its tool_call_id) still present.
        self.assertEqual(scratch, {})
        self.assertIsNone(usage)
        self.assertEqual(len(replay), 4)
        self.assertEqual(replay[1]["tool_call_id"], "call-1")
        self.assertLess(len(replay[1]["content"]), 500)
        self.assertIn("…[truncated]", replay[1]["content"])
        self.assertEqual(replay[3]["content"], "x" * 100)

    async def test_single_round_over_threshold_is_left_alone(self):
        # Nothing older than the newest round exists — no fold possible.
        msgs = _round(1, result_size=9000)
        summarize = AsyncMock()
        with patch.object(llm_node_module, "_summarize_for_compaction", summarize):
            replay, scratch, _ = await _compact_loop_messages(
                _state(), {"compaction_threshold_tokens": 1}, msgs, False
            )
        summarize.assert_not_awaited()
        self.assertEqual(replay, msgs)
        self.assertEqual(scratch, {})


if __name__ == "__main__":
    unittest.main()
