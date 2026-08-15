"""Common interface for realtime voice provider adapters.

An adapter owns the upstream connection to one vendor's realtime API and
translates between vendor events and the session's client-facing protocol
(see voice/session.py). Adapters receive:

  emit(event: dict)            — async callback that sends a JSON event to the client
  tool_executor(name, args)    — async callback that runs a tool and returns text
"""
from abc import ABC, abstractmethod


class VoiceAdapter(ABC):
    # PCM16 sample rates the client must use with this provider
    input_rate: int
    output_rate: int
    model: str

    @abstractmethod
    async def start(self) -> None:
        """Connect to the vendor and configure the session (instructions, tools, VAD)."""

    @abstractmethod
    async def send_audio_b64(self, audio_b64: str) -> None:
        """Forward a base64-encoded PCM16 audio chunk from the client's microphone."""

    @abstractmethod
    async def run(self) -> None:
        """Read vendor events until the connection closes, emitting client events."""

    @abstractmethod
    async def close(self) -> None:
        """Tear down the upstream connection."""
