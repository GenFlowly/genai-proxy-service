"""OpenAI Realtime API adapter (WebSocket, GA protocol).

Audio is PCM16 @ 24kHz in both directions. Server-side semantic VAD handles
turn taking; function calls are executed via the session's tool executor and
their outputs fed back with conversation.item.create + response.create.
"""
import asyncio
import json
import logging
import os

import websockets

from voice.adapters.base import VoiceAdapter
from voice.graph_tool import KNOWLEDGE_TOOL

logger = logging.getLogger(__name__)

REALTIME_URL = "wss://api.openai.com/v1/realtime"
DEFAULT_MODEL = os.environ.get("OPENAI_REALTIME_MODEL", "gpt-realtime-2.1")
# Transcribes the user's speech for transcript persistence. Project-scoped API
# keys only see the transcription models enabled for the project; when this
# model isn't among them OpenAI emits input_audio_transcription.failed per
# utterance and no user transcripts (or messages) are ever produced.
TRANSCRIBE_MODEL = os.environ.get("OPENAI_TRANSCRIBE_MODEL", "gpt-live-transcribe")
DEFAULT_VOICE = "marin"


class OpenAIRealtimeAdapter(VoiceAdapter):
    input_rate = 24000
    output_rate = 24000

    def __init__(self, api_key: str, emit, tool_executor, model: str | None = None,
                 voice: str | None = None, instructions: str | None = None,
                 history: list | None = None):
        self._api_key = api_key
        self._emit = emit
        self._tool_executor = tool_executor
        self.model = model or DEFAULT_MODEL
        self._voice = voice or DEFAULT_VOICE
        self._instructions = instructions or (
            "You are a helpful voice assistant. Answer questions about the user's "
            "stored data by calling the search_knowledge_base tool."
        )
        self._history = history or []
        self._ws = None
        # Assistant transcript is held until response.done so the usage event
        # (parsed from response.done) can be emitted before transcript.done —
        # consumers attach the turn's usage to the assistant message.
        self._pending_assistant_transcript = ""

    async def start(self) -> None:
        url = f"{REALTIME_URL}?model={self.model}"
        headers = {"Authorization": f"Bearer {self._api_key}"}
        try:
            self._ws = await websockets.connect(url, additional_headers=headers, max_size=None)
        except TypeError:
            # websockets < 13 uses extra_headers
            self._ws = await websockets.connect(url, extra_headers=headers, max_size=None)

        await self._send({
            "type": "session.update",
            "session": {
                "type": "realtime",
                "output_modalities": ["audio"],
                "audio": {
                    "input": {
                        "format": {"type": "audio/pcm", "rate": self.input_rate},
                        "turn_detection": {"type": "semantic_vad"},
                        "transcription": {"model": TRANSCRIBE_MODEL},
                    },
                    "output": {
                        "format": {"type": "audio/pcm", "rate": self.output_rate},
                        "voice": self._voice,
                    },
                },
                "instructions": self._instructions,
                "tools": [{
                    "type": "function",
                    "name": KNOWLEDGE_TOOL["name"],
                    "description": KNOWLEDGE_TOOL["description"],
                    "parameters": KNOWLEDGE_TOOL["parameters"],
                }],
            },
        })
        # Seed prior conversation turns so the voice model has context
        for turn in self._history:
            role = turn.get("role", "user")
            text = turn.get("content", "")
            if not text:
                continue
            content_type = "text" if role == "assistant" else "input_text"
            await self._send({
                "type": "conversation.item.create",
                "item": {
                    "type": "message",
                    "role": role,
                    "content": [{"type": content_type, "text": text}],
                },
            })

        logger.info(
            "OpenAI Realtime session configured: model=%s voice=%s history_turns=%d",
            self.model, self._voice, len(self._history),
        )

    async def send_audio_b64(self, audio_b64: str) -> None:
        if audio_b64:
            await self._send({"type": "input_audio_buffer.append", "audio": audio_b64})

    async def run(self) -> None:
        try:
            async for raw in self._ws:
                event = json.loads(raw)
                await self._handle_event(event)
        except websockets.ConnectionClosed as e:
            logger.info("OpenAI Realtime connection closed: %s", e)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.error("OpenAI Realtime reader failed: %s", e, exc_info=True)
            await self._emit({"type": "error", "message": str(e)})

    async def close(self) -> None:
        if self._ws is not None:
            await self._ws.close()

    async def _send(self, event: dict) -> None:
        await self._ws.send(json.dumps(event))

    async def _handle_event(self, event: dict) -> None:
        etype = event.get("type", "")

        if etype == "response.output_audio.delta":
            await self._emit({"type": "output_audio.delta", "audio": event.get("delta", "")})
        elif etype == "response.output_audio.done":
            await self._emit({"type": "output_audio.done"})
        elif etype == "response.output_audio_transcript.delta":
            await self._emit({"type": "transcript.delta", "role": "assistant", "text": event.get("delta", "")})
        elif etype == "response.output_audio_transcript.done":
            self._pending_assistant_transcript = event.get("transcript", "")
        elif etype == "conversation.item.input_audio_transcription.completed":
            await self._emit({"type": "transcript.done", "role": "user", "text": event.get("transcript", "")})
        elif etype == "conversation.item.input_audio_transcription.failed":
            message = (event.get("error") or {}).get("message", "unknown error")
            logger.warning("User transcription failed (model=%s): %s", TRANSCRIBE_MODEL, message)
            await self._emit({"type": "error", "message": f"User transcription failed: {message}"})
        elif etype == "input_audio_buffer.speech_started":
            # User started talking over the assistant — client should stop playback
            await self._emit({"type": "interrupted"})
        elif etype == "response.done":
            usage = (event.get("response") or {}).get("usage") or {}
            if usage:
                in_det = usage.get("input_token_details") or {}
                cached_det = in_det.get("cached_tokens_details") or {}
                out_det = usage.get("output_token_details") or {}
                await self._emit({
                    "type": "usage",
                    "usage": {
                        "input_tokens": usage.get("input_tokens", 0),
                        "output_tokens": usage.get("output_tokens", 0),
                        "total_tokens": usage.get("total_tokens", 0),
                        "cache_read_tokens": in_det.get("cached_tokens", 0),
                        # Modality breakdown for exact cost computation — audio
                        # tokens are billed at different rates than text tokens.
                        # input_*_tokens include the cached_*_tokens subset.
                        "details": {
                            "input_text_tokens": in_det.get("text_tokens", 0),
                            "input_audio_tokens": in_det.get("audio_tokens", 0),
                            "cached_text_tokens": cached_det.get("text_tokens", 0),
                            "cached_audio_tokens": cached_det.get("audio_tokens", 0),
                            "output_text_tokens": out_det.get("text_tokens", 0),
                            "output_audio_tokens": out_det.get("audio_tokens", 0),
                        },
                    },
                })
            if self._pending_assistant_transcript:
                await self._emit({
                    "type": "transcript.done",
                    "role": "assistant",
                    "text": self._pending_assistant_transcript,
                })
                self._pending_assistant_transcript = ""
            for item in (event.get("response", {}).get("output") or []):
                if item.get("type") == "function_call":
                    await self._handle_function_call(item)
        elif etype == "error":
            message = (event.get("error") or {}).get("message", "unknown error")
            logger.warning("OpenAI Realtime error event: %s", message)
            await self._emit({"type": "error", "message": message})

    async def _handle_function_call(self, item: dict) -> None:
        name = item.get("name", "")
        call_id = item.get("call_id", "")
        try:
            args = json.loads(item.get("arguments") or "{}")
        except json.JSONDecodeError:
            args = {}

        await self._emit({"type": "tool.started", "name": name, "args": args})
        output = await self._tool_executor(name, args)
        await self._send({
            "type": "conversation.item.create",
            "item": {
                "type": "function_call_output",
                "call_id": call_id,
                "output": json.dumps({"result": output}),
            },
        })
        await self._send({"type": "response.create"})
        await self._emit({"type": "tool.completed", "name": name})
