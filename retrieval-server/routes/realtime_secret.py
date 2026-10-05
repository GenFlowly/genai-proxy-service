"""Mint OpenAI Realtime ephemeral client secrets.

A browser Realtime client (WebRTC) must never hold a long-lived vendor key.
OpenAI's prescribed pattern is to exchange the platform key server-side for a
short-lived client secret (POST /v1/realtime/client_secrets) and hand only
that token to the browser; the browser then redeems it once against
/v1/realtime/calls. This endpoint performs the exchange so genai-proxy-server
customers never need to call OpenAI directly — the vendor key stays inside
genflowly's credential store.
"""
import logging

from fastapi import APIRouter
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter()

_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets"


class RealtimeClientSecretRequest(BaseModel):
    api_key: str
    model: str  # e.g. "gpt-realtime-2.1"
    instructions: str
    voice: str | None = None  # e.g. "marin"
    # Input-audio transcription model (e.g. "whisper-1"). Best-effort: if the
    # vendor rejects the session config with it, we retry once without it —
    # callers prefer a session lacking transcription over no session.
    input_transcription_model: str | None = None


class RealtimeClientSecretResponse(BaseModel):
    value: str | None = None  # the ephemeral secret ("ek_..."); None on error
    expires_at: int | None = None  # unix seconds
    model: str
    error: str | None = None


def _session_payload(req: RealtimeClientSecretRequest, with_transcription: bool) -> dict:
    session: dict = {
        "type": "realtime",
        "model": req.model,
        "instructions": req.instructions,
    }
    audio: dict = {}
    if req.voice:
        audio["output"] = {"voice": req.voice}
    if with_transcription and req.input_transcription_model:
        audio["input"] = {"transcription": {"model": req.input_transcription_model}}
    if audio:
        session["audio"] = audio
    return {"session": session}


@router.post("/voice/client-secret")
async def create_realtime_client_secret(
    req: RealtimeClientSecretRequest,
) -> RealtimeClientSecretResponse:
    import httpx

    attempts = [True, False] if req.input_transcription_model else [True]
    last_error: str | None = None

    async with httpx.AsyncClient(timeout=30) as client:
        for with_transcription in attempts:
            response = await client.post(
                _CLIENT_SECRETS_URL,
                headers={"Authorization": f"Bearer {req.api_key}"},
                json=_session_payload(req, with_transcription),
            )
            if response.is_success:
                data = response.json()
                # Current shape is top-level {value, expires_at}; older
                # deployments nested them under client_secret.
                nested = data.get("client_secret") or {}
                value = data.get("value") or nested.get("value")
                expires_at = data.get("expires_at") or nested.get("expires_at")
                if not value:
                    logger.warning("client_secrets response had no secret value")
                    return RealtimeClientSecretResponse(
                        model=req.model, error="Vendor response had no secret value"
                    )
                return RealtimeClientSecretResponse(
                    value=value, expires_at=expires_at, model=req.model
                )

            last_error = f"{response.status_code}: {response.text[:300]}"
            logger.info(
                "client_secrets mint failed (transcription=%s): %s",
                with_transcription, last_error,
            )
            # Auth failures won't be fixed by dropping the transcription block.
            if response.status_code in (401, 403):
                break

    return RealtimeClientSecretResponse(model=req.model, error=last_error)
