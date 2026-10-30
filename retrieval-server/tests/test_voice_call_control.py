"""
Unit tests for the voice control-channel registry lifecycle.

Run with `python -m unittest tests.test_voice_call_control`.

The module-level _registry must not retain CallControl entries past the call's
life: explicit detach(), a remote close / reader failure, and the idle sweep
inside attach() all have to reap their entry, while a live re-attached control
under the same call_id must never be evicted by a stale leg's cleanup.

The upstream WebSocket is faked: attach() only needs websockets.connect to
return something iterable with send/close, so no network is involved.
"""
import asyncio
import contextlib
import time
import unittest
from unittest.mock import AsyncMock, patch

import voice.call_control as call_control


class _FakeWS:
    def __init__(self, messages=()):
        self._messages = list(messages)
        self.sent = []
        self.close_calls = 0

    def __aiter__(self):
        return self._iter()

    async def _iter(self):
        for message in self._messages:
            yield message

    async def send(self, data):
        self.sent.append(data)

    async def close(self):
        self.close_calls += 1


async def _settle(control):
    if control.reader_task is not None:
        with contextlib.suppress(asyncio.CancelledError):
            await control.reader_task


class CallControlRegistryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        call_control._registry.clear()

    def tearDown(self):
        call_control._registry.clear()

    async def _attach(self, call_id, ws=None, customer_id="cust-1"):
        ws = ws or _FakeWS()
        with patch.object(call_control.websockets, "connect", AsyncMock(return_value=ws)):
            return await call_control.attach(call_id, "sk-test", customer_id, None, None, None)

    async def test_remote_close_reaps_registry_entry_without_detach(self):
        control = await self._attach("call-1")
        self.assertIn("call-1", call_control._registry)

        await control.reader_task  # fake ws ends iteration = remote close

        self.assertNotIn("call-1", call_control._registry)
        self.assertTrue(control.closed)
        self.assertEqual(control.close_reason, "remote_closed")

    async def test_reader_failure_reaps_registry_entry(self):
        class _BrokenWS(_FakeWS):
            async def _iter(self):
                raise RuntimeError("socket torn down")
                yield  # pragma: no cover

        control = await self._attach("call-2", ws=_BrokenWS())
        await control.reader_task

        self.assertNotIn("call-2", call_control._registry)
        self.assertTrue(control.closed)
        self.assertEqual(control.last_error, "socket torn down")

    async def test_sweep_purges_closed_entry_on_next_attach(self):
        stale = call_control.CallControl("stale", "cust-1", _FakeWS(), None, None)
        stale.closed = True
        call_control._registry["stale"] = stale

        control = await self._attach("call-3")

        self.assertNotIn("stale", call_control._registry)
        self.assertIn("call-3", call_control._registry)
        await call_control.detach(control)
        await _settle(control)

    async def test_sweep_closes_and_purges_idle_entry_on_next_attach(self):
        idle_ws = _FakeWS()
        idle = call_control.CallControl("idle", "cust-1", idle_ws, None, None)
        idle.last_activity = time.time() - call_control.IDLE_REAP_SECONDS - 1
        call_control._registry["idle"] = idle

        control = await self._attach("call-4")

        self.assertNotIn("idle", call_control._registry)
        self.assertTrue(idle.closed)
        self.assertEqual(idle.close_reason, "idle_reaped")
        self.assertEqual(idle_ws.close_calls, 1)
        await call_control.detach(control)
        await _settle(control)

    async def test_sweep_keeps_live_recent_entries(self):
        live = call_control.CallControl("live", "cust-1", _FakeWS(), None, None)
        call_control._registry["live"] = live

        control = await self._attach("call-5")

        self.assertIn("live", call_control._registry)
        self.assertFalse(live.closed)
        await call_control.detach(control)
        await _settle(control)

    async def test_detach_removes_entry_and_is_idempotent(self):
        control = await self._attach("call-6")

        summary = await call_control.detach(control)
        self.assertEqual(summary["call_id"], "call-6")
        self.assertNotIn("call-6", call_control._registry)

        again = await call_control.detach(control)
        self.assertFalse(again["attached"])
        self.assertNotIn("call-6", call_control._registry)
        await _settle(control)

    async def test_stale_leg_never_evicts_reattached_control(self):
        old = call_control.CallControl("call-7", "cust-1", _FakeWS(), None, None)
        replacement = call_control.CallControl("call-7", "cust-1", _FakeWS(), None, None)
        call_control._registry["call-7"] = replacement

        await call_control._reader(old)
        self.assertIs(call_control._registry.get("call-7"), replacement)

        await call_control.detach(old)
        self.assertIs(call_control._registry.get("call-7"), replacement)


if __name__ == "__main__":
    unittest.main()
