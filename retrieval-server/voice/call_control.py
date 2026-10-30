"""Server-side control channel for browser-held WebRTC Realtime calls.

A browser WebRTC client and a server WebSocket can share one OpenAI Realtime
session: the browser's SDP exchange returns a call id (Location header), and
wss://api.openai.com/v1/realtime?call_id=... joins the same session with full
event rights. This module holds that control leg per call: it forwards caller
events (session.update, conversation.item.create, response.create, ...),
relays the model's function calls to a customer webhook and feeds the outputs
back, and accumulates usage from response.done for metering.

State is process-local (an in-memory registry of live WebSockets) — the same
single-process assumption the voice WebSocket relay already makes. A control
leg dies silently with the call; detach() or the remote close reaps it, and
attach() sweeps out anything closed or idle past IDLE_REAP_SECONDS as a
backstop.
"""
import asyncio
import json
import logging
import time

import websockets

logger = logging.getLogger(__name__)

REALTIME_URL = "wss://api.openai.com/v1/realtime"

# A control leg idle this long is presumed orphaned and swept on the next
# attach(); a live call keeps touching last_activity through its reader.
IDLE_REAP_SECONDS = 3600.0

# Caller events we will forward to the session. Everything else is refused —
# in particular input_audio_buffer.* (audio belongs to the browser leg).
ALLOWED_EVENT_TYPES = {
    "session.update",
    "conversation.item.create",
    "conversation.item.delete",
    "response.create",
    "response.cancel",
}


class CallControl:
    def __init__(self, call_id: str, customer_id: str, ws,
                 webhook_url: str | None, webhook_secret: str | None):
        self.call_id = call_id
        self.customer_id = customer_id
        self.ws = ws
        self.webhook_url = webhook_url
        self.webhook_secret = webhook_secret
        self.attached_at = time.time()
        self.last_activity = time.time()
        self.closed = False
        self.close_reason: str | None = None
        self.reader_task: asyncio.Task | None = None
        # Usage accumulated across every response.done seen on this call.
        self.usage = {
            "input_tokens": 0, "output_tokens": 0, "total_tokens": 0,
            "cache_read_tokens": 0, "input_text_tokens": 0,
            "input_audio_tokens": 0, "output_text_tokens": 0,
            "output_audio_tokens": 0, "responses": 0,
        }
        self.tool_calls_relayed = 0
        self.last_error: str | None = None

    def touch(self) -> None:
        self.last_activity = time.time()

    def summary(self) -> dict:
        return {
            "call_id": self.call_id,
            "attached": not self.closed,
            "attached_at": self.attached_at,
            "close_reason": self.close_reason,
            "usage": dict(self.usage),
            "tool_calls_relayed": self.tool_calls_relayed,
            "last_error": self.last_error,
        }


_registry: dict[str, CallControl] = {}


def _discard(control: CallControl) -> None:
    # Identity check: a reaped leg must never evict a fresh control that was
    # re-attached under the same call_id.
    if _registry.get(control.call_id) is control:
        del _registry[control.call_id]


async def _sweep() -> None:
    now = time.time()
    for control in list(_registry.values()):
        if control.closed:
            _discard(control)
        elif now - control.last_activity > IDLE_REAP_SECONDS:
            logger.info("Reaping idle control channel for call %s", control.call_id)
            await _close(control, "idle_reaped")


def get_control(call_id: str, customer_id: str) -> CallControl | None:
    control = _registry.get(call_id)
    if control is None or control.customer_id != customer_id:
        return None
    control.touch()
    return control


async def attach(call_id: str, api_key: str, customer_id: str,
                 session_update: dict | None,
                 webhook_url: str | None, webhook_secret: str | None) -> CallControl:
    """Opens the control WebSocket for a live call and starts its reader."""
    await _sweep()
    existing = _registry.get(call_id)
    if existing is not None and not existing.closed:
        if existing.customer_id != customer_id:
            raise PermissionError("call_id is attached by another customer")
        existing.touch()
        return existing  # idempotent re-attach

    url = f"{REALTIME_URL}?call_id={call_id}"
    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        ws = await websockets.connect(url, additional_headers=headers, max_size=None)
    except TypeError:  # websockets < 13
        ws = await websockets.connect(url, extra_headers=headers, max_size=None)

    control = CallControl(call_id, customer_id, ws, webhook_url, webhook_secret)
    _registry[call_id] = control

    if session_update:
        await ws.send(json.dumps({"type": "session.update", "session": session_update}))

    control.reader_task = asyncio.create_task(_reader(control))
    logger.info("Attached control channel to call %s (customer %s)", call_id, customer_id)
    return control


async def send_events(control: CallControl, events: list[dict]) -> int:
    sent = 0
    for event in events:
        etype = event.get("type")
        if etype not in ALLOWED_EVENT_TYPES:
            raise ValueError(f"Event type not allowed on the control channel: {etype!r}")
        await control.ws.send(json.dumps(event))
        sent += 1
    control.touch()
    return sent


async def detach(control: CallControl, reason: str = "detached") -> dict:
    summary = control.summary()
    await _close(control, reason)
    _discard(control)
    return summary


async def _close(control: CallControl, reason: str) -> None:
    if control.closed:
        return
    control.closed = True
    control.close_reason = reason
    if control.reader_task is not None and control.reader_task is not asyncio.current_task():
        control.reader_task.cancel()
    try:
        await control.ws.close()
    except Exception:
        pass
    _discard(control)


async def _reader(control: CallControl) -> None:
    """Reads session events: accumulates usage, relays function calls."""
    try:
        async for raw in control.ws:
            control.touch()
            try:
                event = json.loads(raw)
            except json.JSONDecodeError:
                continue
            etype = event.get("type", "")
            if etype == "response.done":
                _record_usage(control, event)
                for item in (event.get("response", {}).get("output") or []):
                    if item.get("type") == "function_call":
                        # Serial relay keeps tool outputs ordered; interview
                        # tools are cheap bookkeeping calls.
                        await _relay_function_call(control, item)
            elif etype == "error":
                message = (event.get("error") or {}).get("message", "unknown error")
                control.last_error = message
                logger.warning("Control channel %s error event: %s", control.call_id, message)
    except websockets.ConnectionClosed as e:
        logger.info("Control channel %s closed: %s", control.call_id, e)
    except asyncio.CancelledError:
        return
    except Exception as e:
        control.last_error = str(e)
        logger.error("Control channel %s reader failed: %s", control.call_id, e, exc_info=True)
    finally:
        control.closed = True
        control.close_reason = control.close_reason or "remote_closed"
        _discard(control)


def _record_usage(control: CallControl, event: dict) -> None:
    usage = (event.get("response") or {}).get("usage") or {}
    if not usage:
        return
    in_det = usage.get("input_token_details") or {}
    out_det = usage.get("output_token_details") or {}
    u = control.usage
    u["input_tokens"] += usage.get("input_tokens", 0)
    u["output_tokens"] += usage.get("output_tokens", 0)
    u["total_tokens"] += usage.get("total_tokens", 0)
    u["cache_read_tokens"] += in_det.get("cached_tokens", 0)
    u["input_text_tokens"] += in_det.get("text_tokens", 0)
    u["input_audio_tokens"] += in_det.get("audio_tokens", 0)
    u["output_text_tokens"] += out_det.get("text_tokens", 0)
    u["output_audio_tokens"] += out_det.get("audio_tokens", 0)
    u["responses"] += 1


async def _relay_function_call(control: CallControl, item: dict) -> None:
    name = item.get("name", "")
    tool_call_id = item.get("call_id", "")
    arguments = item.get("arguments") or "{}"

    if not control.webhook_url:
        output = json.dumps({"error": f"No tool webhook configured; call to '{name}' dropped"})
    else:
        output = await _post_webhook(control, name, tool_call_id, arguments)

    control.tool_calls_relayed += 1
    try:
        await control.ws.send(json.dumps({
            "type": "conversation.item.create",
            "item": {
                "type": "function_call_output",
                "call_id": tool_call_id,
                "output": output,
            },
        }))
        await control.ws.send(json.dumps({"type": "response.create"}))
    except Exception as e:
        logger.warning("Control channel %s: failed to send tool output: %s", control.call_id, e)


async def _post_webhook(control: CallControl, name: str, tool_call_id: str, arguments: str) -> str:
    import httpx

    headers = {"Content-Type": "application/json"}
    if control.webhook_secret:
        headers["X-Genflowly-Webhook-Secret"] = control.webhook_secret
    payload = {
        "call_id": control.call_id,
        "tool_call_id": tool_call_id,
        "name": name,
        "arguments": arguments,
    }
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(control.webhook_url, json=payload, headers=headers)
            response.raise_for_status()
            data = response.json()
            return data.get("output") or json.dumps({"result": "ok"})
    except Exception as e:
        logger.warning("Tool webhook failed for call %s tool %s: %s", control.call_id, name, e)
        return json.dumps({"error": f"Tool execution failed: {e}"})
