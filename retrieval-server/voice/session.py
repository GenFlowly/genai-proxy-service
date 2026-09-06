"""Voice session orchestration: client WebSocket <-> provider adapter.

Client protocol (JSON text frames):

  client -> server
    {"type": "session.init", "provider": "openai"|"gemini", "customer_id": str,
     "llm_credentials": {...}, "client": str?, "model": str?, "voice": str?,
     "system_prompt": str?, "agentic": bool?, "graph_provider": str?,
     "graph_model": str?,
     "conversation_history": [{"role": "user"|"assistant", "content": str}]?}
    {"type": "input_audio.append", "audio": "<base64 PCM16>"}
    {"type": "session.close"}

  server -> client
    {"type": "session.ready", "provider": str, "model": str,
     "input_rate": int, "output_rate": int}
    {"type": "output_audio.delta", "audio": "<base64 PCM16>"}
    {"type": "output_audio.done"}
    {"type": "transcript.delta"|"transcript.done", "role": "user"|"assistant", "text": str}
    {"type": "tool.started"|"tool.completed", "name": str}
    {"type": "usage", "usage": {"input_tokens": int, "output_tokens": int,
     "total_tokens": int, "cache_read_tokens": int}}   # per turn, before the
                                                       # assistant transcript.done
    {"type": "interrupted"}
    {"type": "error", "message": str}

Anthropic has no realtime voice API, so "claude" is not a valid provider here.
"""
import asyncio
import json
import logging
import time

from fastapi import WebSocket, WebSocketDisconnect

from encoding_library.observability import count, observe
from voice.graph_tool import make_graph_tool_executor

logger = logging.getLogger(__name__)

_PROVIDER_KEY_NAMES = {
    "openai": "openai_api_key",
    "gemini": "gemini_api_key",
}

_INIT_TIMEOUT_SECONDS = 15


def _make_adapter(provider: str, api_key: str, init: dict, emit, tool_executor):
    common = dict(
        api_key=api_key,
        emit=emit,
        tool_executor=tool_executor,
        model=init.get("model"),
        voice=init.get("voice"),
        instructions=init.get("system_prompt"),
        history=init.get("conversation_history") or [],
    )
    if provider == "openai":
        from voice.adapters.openai_realtime import OpenAIRealtimeAdapter
        return OpenAIRealtimeAdapter(**common)
    from voice.adapters.gemini_live import GeminiLiveAdapter
    return GeminiLiveAdapter(**common)


async def handle_voice_session(websocket: WebSocket) -> None:
    await websocket.accept()

    send_lock = asyncio.Lock()

    async def emit(event: dict) -> None:
        async with send_lock:
            await websocket.send_text(json.dumps(event))

    async def fail(message: str) -> None:
        logger.warning("Voice session rejected: %s", message)
        try:
            await emit({"type": "error", "message": message})
            await websocket.close()
        except Exception:
            pass

    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=_INIT_TIMEOUT_SECONDS)
        init = json.loads(raw)
    except asyncio.TimeoutError:
        return await fail("Expected session.init within 15s")
    except (WebSocketDisconnect, json.JSONDecodeError):
        return

    if init.get("type") != "session.init":
        return await fail("First message must be session.init")

    provider = init.get("provider", "")
    key_name = _PROVIDER_KEY_NAMES.get(provider)
    if key_name is None:
        return await fail(f"Unsupported voice provider: '{provider}' (use openai or gemini)")

    api_key = (init.get("llm_credentials") or {}).get(key_name)
    if not api_key:
        return await fail(f"Missing {key_name} in llm_credentials")
    if not init.get("customer_id"):
        return await fail("Missing customer_id")

    tool_executor = make_graph_tool_executor(init)
    adapter = _make_adapter(provider, api_key, init, emit, tool_executor)

    try:
        await adapter.start()
    except Exception as e:
        count("voice_session_total", status="connect_failed", vendor=provider)
        logger.error("Voice adapter start failed (provider=%s): %s", provider, e, exc_info=True)
        return await fail(f"Failed to connect to {provider}: {e}")

    await emit({
        "type": "session.ready",
        "provider": provider,
        "model": adapter.model,
        "input_rate": adapter.input_rate,
        "output_rate": adapter.output_rate,
    })
    logger.info(
        "Voice session started: customer=%s provider=%s model=%s",
        init.get("customer_id"), provider, adapter.model,
    )

    session_start = time.perf_counter()
    session_status = "ok"
    reader = asyncio.create_task(adapter.run())
    try:
        while True:
            if reader.done():
                break
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = data.get("type")
            if msg_type == "input_audio.append":
                await adapter.send_audio_b64(data.get("audio", ""))
            elif msg_type == "session.close":
                break
    except WebSocketDisconnect:
        logger.info("Voice session client disconnected: customer=%s", init.get("customer_id"))
    except Exception as e:
        session_status = "error"
        logger.error("Voice session failed: %s", e, exc_info=True)
    finally:
        count("voice_session_total", status=session_status, vendor=provider)
        observe("voice_session_duration_seconds", time.perf_counter() - session_start, vendor=provider)
        reader.cancel()
        try:
            await adapter.close()
        except Exception:
            pass
        try:
            await websocket.close()
        except Exception:
            pass
        logger.info("Voice session ended: customer=%s", init.get("customer_id"))
