"""
Unit tests for activity.schema, the activity log's wire contract.

Run with `python -m unittest tests.test_activity_schema`.
"""
import unittest

from activity import schema


def _call(**overrides):
    call = {"id": "c1", "seq": 1, "name": "web_search", "args": {}, "mode": "run", "sources": []}
    call.update(overrides)
    return call


class BuilderRoundTripTests(unittest.TestCase):
    def test_every_builder_produces_a_valid_event(self):
        events = [
            schema.turn_start(),
            schema.step_start(10, "N:1", schema.KIND_LLM, "N", "Agent"),
            schema.step_progress(20, "N:1", 10),
            schema.step_calling(25, "N:1"),
            schema.step_writing(26, "N:1"),
            schema.step_call(30, "T:1", {"name": "web_search", "mode": "skip"}),
            schema.step_end(40, "M:1", schema.KIND_MEMORY, "M", "Memory", 5, counts={"core": 1, "recalled": 0}),
            schema.step_end(40, "N:1", schema.KIND_LLM, "N", "Agent", 30, outcome=schema.OUTCOME_ANSWER),
            schema.step_end(40, "T:1", schema.KIND_TOOLS, "T", "Tools", 30, calls=[_call()]),
            schema.step_end(40, "H:1", schema.KIND_INPUT, "H", "Ask", 3),
            schema.turn_end(50, 50, schema.TURN_COMPLETED),
        ]
        for event in events:
            with self.subTest(type=event["type"]):
                schema.validate(event)
                self.assertEqual(event["v"], schema.ACTIVITY_VERSION)

    def test_none_fields_are_left_out(self):
        event = schema.step_end(1, "N:1", schema.KIND_LLM, "N", "Agent", None, outcome="answer", reasoning=None)
        self.assertNotIn("duration_ms", event)
        self.assertNotIn("reasoning", event)

    def test_converted_history_may_have_no_timestamps(self):
        schema.validate(schema.step_start(None, "N:1", schema.KIND_LLM, "N", "Agent"))


class RejectionTests(unittest.TestCase):
    def _rejects(self, event):
        with self.assertRaises(ValueError):
            schema.validate(event)

    def test_missing_required_keys(self):
        self._rejects({"v": 2, "at": 0, "type": "step.start", "id": "N:1", "kind": "llm", "node": "N"})
        self._rejects({"v": 2, "at": 0, "type": "step.end", "id": "M:1", "kind": "memory", "node": "M", "name": "Memory"})
        self._rejects({"v": 2, "at": 0, "type": "step.end", "id": "T:1", "kind": "tools", "node": "T", "name": "Tools"})

    def test_wrong_version_type_kind_outcome_or_mode(self):
        self._rejects({**schema.turn_start(), "v": 1})
        self._rejects({"v": 2, "at": 0, "type": "thinking_step"})
        self._rejects(schema.step_start(0, "N:1", "TOOL", "N", "Agent"))
        self._rejects(schema.step_end(0, "N:1", schema.KIND_LLM, "N", "Agent", 1, outcome="maybe"))
        self._rejects(schema.step_end(0, "T:1", schema.KIND_TOOLS, "T", "Tools", 1, calls=[_call(mode="later")]))
        self._rejects(schema.turn_end(0, 0, "cancelled"))

    def test_bad_timestamps_and_shapes(self):
        self._rejects({**schema.turn_start(), "at": -1})
        self._rejects({"v": 2, "type": "turn.start"})
        self._rejects("turn.start")
        self._rejects(schema.step_end(0, "T:1", schema.KIND_TOOLS, "T", "Tools", 1, calls=[_call(sources=None)]))
        self._rejects(schema.step_call(0, "T:1", {"name": "web_search"}))


if __name__ == "__main__":
    unittest.main()
