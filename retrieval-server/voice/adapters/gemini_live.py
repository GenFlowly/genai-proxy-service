"""Gemini Live API adapter (google-genai SDK).

Audio is PCM16: 16kHz in, 24kHz out. The SDK manages the WebSocket; tool calls
arrive as message.tool_call and are answered with send_tool_response.
"""
import asyncio
import base64
import logging
import os

from google import genai
from google.genai import types

from voice.adapters.base import VoiceAdapter
from voice.graph_tool import KNOWLEDGE_TOOL

logger = logging.getLogger(__name__)

DEFAULT_MODEL = os.environ.get("GEMINI_LIVE_MODEL", "gemini-2.5-flash-native-audio-preview-12-2025")


class GeminiLiveAdapter(VoiceAdapter):
    input_rate = 16000
    output_rate = 24000

    def __init__(self, api_key: str, emit, tool_executor, model: str | None = None,
                 voice: str | None = None, instructions: str | None = None,
                 history: list | None = None):
        self._api_key = api_key
        self._emit = emit
        self._tool_executor = tool_executor
        self.model = model or DEFAULT_MODEL
        self._voice = voice
        self._instructions = instructions or (
            "You are a helpful voice assistant. Answer questions about the user's "
            "stored data by calling the search_knowledge_base tool."
        )
        self._history = history or []
        self._cm = None
        self._session = None
        # Gemini only streams incremental transcription fragments; aggregate them
        # per turn so clients also get transcript.done events (like OpenAI).
        self._user_transcript = ""
        self._assistant_transcript = ""
        self._usage: dict | None = None

    async def start(self) -> None:
        client = genai.Client(api_key=self._api_key)

        speech_config = None
        if self._voice:
            speech_config = types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=self._voice)
                )
            )

        config = types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            system_instruction=self._instructions,
            speech_config=speech_config,
            input_audio_transcription=types.AudioTranscriptionConfig(),
            output_audio_transcription=types.AudioTranscriptionConfig(),
            tools=[types.Tool(function_declarations=[
                types.FunctionDeclaration(
                    name=KNOWLEDGE_TOOL["name"],
                    description=KNOWLEDGE_TOOL["description"],
                    parameters_json_schema=KNOWLEDGE_TOOL["parameters"],
                )
            ])],
        )

        self._cm = client.aio.live.connect(model=self.model, config=config)
        self._session = await self._cm.__aenter__()

        # Seed prior conversation turns so the voice model has context
        turns = [
            types.Content(
                role="model" if t.get("role") == "assistant" else "user",
                parts=[types.Part(text=t.get("content", ""))],
            )
            for t in self._history
            if t.get("content")
        ]
        if turns:
            await self._session.send_client_content(turns=turns, turn_complete=False)

        logger.info(
            "Gemini Live session connected: model=%s voice=%s history_turns=%d",
            self.model, self._voice, len(turns),
        )

    async def send_audio_b64(self, audio_b64: str) -> None:
        if not audio_b64:
            return
        await self._session.send_realtime_input(
            audio=types.Blob(
                data=base64.b64decode(audio_b64),
                mime_type=f"audio/pcm;rate={self.input_rate}",
            )
        )

    async def run(self) -> None:
        try:
            # receive() yields until each turn completes; loop to keep the
            # session alive across turns.
            while True:
                async for message in self._session.receive():
                    await self._handle_message(message)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.info("Gemini Live reader ended: %s", e)
            await self._emit({"type": "error", "message": str(e)})

    async def close(self) -> None:
        if self._cm is not None:
            await self._cm.__aexit__(None, None, None)

    async def _flush_transcripts(self) -> None:
        if self._user_transcript.strip():
            await self._emit({"type": "transcript.done", "role": "user", "text": self._user_transcript.strip()})
        if self._assistant_transcript.strip():
            await self._emit({"type": "transcript.done", "role": "assistant", "text": self._assistant_transcript.strip()})
        self._user_transcript = ""
        self._assistant_transcript = ""

    async def _handle_message(self, message) -> None:
        meta = getattr(message, "usage_metadata", None)
        if meta is not None:
            def _modality_tokens(detail_list, modality_name: str) -> int:
                total = 0
                for d in detail_list or []:
                    modality = getattr(getattr(d, "modality", None), "name", str(getattr(d, "modality", "")))
                    if modality_name in modality.upper():
                        total += getattr(d, "token_count", 0) or 0
                return total

            prompt_det = getattr(meta, "prompt_tokens_details", None)
            response_det = getattr(meta, "response_tokens_details", None)
            cache_det = getattr(meta, "cache_tokens_details", None)
            self._usage = {
                "input_tokens": meta.prompt_token_count or 0,
                "output_tokens": meta.response_token_count or 0,
                "total_tokens": meta.total_token_count or 0,
                "cache_read_tokens": meta.cached_content_token_count or 0,
                # Modality breakdown for exact cost computation (audio tokens
                # are billed at different rates than text tokens)
                "details": {
                    "input_text_tokens": _modality_tokens(prompt_det, "TEXT"),
                    "input_audio_tokens": _modality_tokens(prompt_det, "AUDIO"),
                    "cached_text_tokens": _modality_tokens(cache_det, "TEXT"),
                    "cached_audio_tokens": _modality_tokens(cache_det, "AUDIO"),
                    "output_text_tokens": _modality_tokens(response_det, "TEXT"),
                    "output_audio_tokens": _modality_tokens(response_det, "AUDIO"),
                },
            }

        if message.data:
            await self._emit({
                "type": "output_audio.delta",
                "audio": base64.b64encode(message.data).decode("ascii"),
            })

        content = message.server_content
        if content is not None:
            if getattr(content, "interrupted", None):
                await self._emit({"type": "interrupted"})
            input_tx = getattr(content, "input_transcription", None)
            if input_tx and input_tx.text:
                self._user_transcript += input_tx.text
                await self._emit({"type": "transcript.delta", "role": "user", "text": input_tx.text})
            output_tx = getattr(content, "output_transcription", None)
            if output_tx and output_tx.text:
                self._assistant_transcript += output_tx.text
                await self._emit({"type": "transcript.delta", "role": "assistant", "text": output_tx.text})
            if getattr(content, "turn_complete", None):
                # usage before transcript.done — consumers attach it to the
                # assistant message they persist
                if self._usage:
                    await self._emit({"type": "usage", "usage": self._usage})
                    self._usage = None
                await self._flush_transcripts()
                await self._emit({"type": "output_audio.done"})

        if message.tool_call:
            for fc in message.tool_call.function_calls:
                args = dict(fc.args or {})
                await self._emit({"type": "tool.started", "name": fc.name, "args": args})
                output = await self._tool_executor(fc.name, args)
                await self._session.send_tool_response(function_responses=[
                    types.FunctionResponse(id=fc.id, name=fc.name, response={"result": output})
                ])
                await self._emit({"type": "tool.completed", "name": fc.name})
