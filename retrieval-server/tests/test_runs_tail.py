"""
Unit tests for the /runs/{id}/stream tail (routes/runs.py stream_run).

run_events and the DBOS status are faked; the generator is driven to
completion and its SSE frames inspected. Pinned here (plan 0.2): a run that
failed or was dead-lettered without a terminal row ends with the error frames,
then [DONE]; a cancelled run and the idle cap end with a bare [DONE].

Run with `python -m unittest tests.test_runs_tail`.
"""
import contextlib
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import durable_runtime
import run_events
from routes import runs as runs_routes


class _Request:
    headers: dict = {}

    async def is_disconnected(self):
        return False


class _Tail:
    """Fake event channel: `batches` are returned by successive read_since
    calls (then empty); `statuses` by successive _status calls (the last one
    repeats)."""

    def __init__(self, batches=(), statuses=("PENDING",)):
        self.batches = [list(b) for b in batches]
        self.statuses = list(statuses)
        self.reads = 0

    async def read_since(self, run_id, from_seq, limit=500):
        self.reads += 1
        return self.batches.pop(0) if self.batches else []

    async def status(self, run_id):
        value = self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]
        return None if value is None else SimpleNamespace(status=value)


def _row(seq, event, terminal=False):
    return {"seq": seq, "event": event, "terminal": terminal}


async def _drive(tail: _Tail, **module_overrides) -> list[str]:
    async def no_sleep(_seconds):
        return None

    with contextlib.ExitStack() as stack:
        stack.enter_context(patch.object(durable_runtime, "is_ready", lambda: True))
        stack.enter_context(patch.object(run_events, "read_since", tail.read_since))
        stack.enter_context(patch.object(runs_routes, "_status", tail.status))
        stack.enter_context(patch.object(runs_routes, "_sleep", no_sleep))
        for name, value in module_overrides.items():
            stack.enter_context(patch.object(runs_routes, name, value))
        response = await runs_routes.stream_run("run_1", _Request(), from_seq=0)
        return [frame async for frame in response.body_iterator]


def _data(frames: list[str]) -> list:
    """The JSON payloads of the data frames ([DONE] as the string)."""
    out = []
    for frame in frames:
        for line in frame.splitlines():
            if line.startswith("data: "):
                body = line[len("data: "):]
                out.append(body if body == "[DONE]" else json.loads(body))
    return out


class FailedRunTailTest(unittest.IsolatedAsyncioTestCase):
    async def test_dead_lettered_run_yields_the_error_frames_then_done(self):
        frames = await _drive(_Tail(statuses=["MAX_RECOVERY_ATTEMPTS_EXCEEDED"]))
        payloads = _data(frames)
        self.assertEqual(payloads[0], {"error": run_events.RUN_LOST_MESSAGE, "error_type": "run_lost"})
        self.assertEqual(payloads[1]["status"], "error")
        self.assertEqual(payloads[1]["error_type"], "run_lost")
        self.assertEqual(payloads[2], "[DONE]")
        self.assertEqual(len(payloads), 3)

    async def test_errored_run_yields_a_generic_error(self):
        payloads = _data(await _drive(_Tail(statuses=["ERROR"])))
        self.assertEqual(payloads[0], {"error": run_events.RUN_FAILED_MESSAGE, "error_type": "error"})
        self.assertEqual(payloads[-1], "[DONE]")

    async def test_rows_written_before_the_failure_come_first(self):
        tail = _Tail(batches=[[_row(1, {"content": "Hel"})]], statuses=["MAX_RECOVERY_ATTEMPTS_EXCEEDED"])
        frames = await _drive(tail)
        self.assertTrue(frames[0].startswith("id: 1\n"))
        self.assertEqual(_data(frames)[0], {"content": "Hel"})
        self.assertEqual(_data(frames)[1]["error_type"], "run_lost")

    async def test_cancelled_run_ends_with_a_bare_done(self):
        self.assertEqual(_data(await _drive(_Tail(statuses=["CANCELLED"]))), ["[DONE]"])

    async def test_a_terminal_row_already_written_wins(self):
        # The sweep (or the run itself) persisted the terminal row: the drain
        # streams it and the tail adds nothing of its own.
        tail = _Tail(
            batches=[[], [_row(1, {"error": "x", "error_type": "run_lost"}),
                          _row(2, {"status": "error", "error": "x"}, terminal=True)]],
            statuses=["MAX_RECOVERY_ATTEMPTS_EXCEEDED"],
        )
        payloads = _data(await _drive(tail))
        self.assertEqual(payloads, [{"error": "x", "error_type": "run_lost"},
                                    {"status": "error", "error": "x"}, "[DONE]"])

    async def test_completed_run_streams_its_rows_and_done(self):
        tail = _Tail(batches=[[_row(1, {"content": "Hi"}), _row(2, {"status": "completed"}, terminal=True)]])
        self.assertEqual(_data(await _drive(tail)), [{"content": "Hi"}, {"status": "completed"}, "[DONE]"])

    async def test_idle_cap_ends_without_an_error(self):
        # A run still PENDING (e.g. waiting on human input) when the cap fires.
        payloads = _data(await _drive(_Tail(statuses=["PENDING"]), _STREAM_MAX_SEC=2.0))
        self.assertEqual(payloads, ["[DONE]"])


if __name__ == "__main__":
    unittest.main()
