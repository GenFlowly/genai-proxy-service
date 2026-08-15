"""Vendor API key validation.

Model listing (/models) is served from LiteLLM's static catalog and never
touches the vendor, so it can't tell whether a key works. This endpoint makes
one cheap authenticated call to the vendor (their list-models API) purely to
check the key.
"""
import logging

from fastapi import APIRouter
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter()


class ValidateKeyRequest(BaseModel):
    provider: str  # "openai" | "anthropic" | "gemini"
    api_key: str


class ValidateKeyResponse(BaseModel):
    provider: str
    valid: bool
    error: str | None = None


async def _check_openai(api_key: str) -> None:
    from openai import AsyncOpenAI
    await AsyncOpenAI(api_key=api_key).models.list()


async def _check_anthropic(api_key: str) -> None:
    from anthropic import AsyncAnthropic
    await AsyncAnthropic(api_key=api_key).models.list(limit=1)


async def _check_gemini(api_key: str) -> None:
    from google import genai
    await genai.Client(api_key=api_key).aio.models.list()


_CHECKERS = {
    "openai": _check_openai,
    "anthropic": _check_anthropic,
    "gemini": _check_gemini,
}


@router.post("/validate-key")
async def validate_key(req: ValidateKeyRequest) -> ValidateKeyResponse:
    checker = _CHECKERS.get(req.provider)
    if checker is None:
        return ValidateKeyResponse(provider=req.provider, valid=False, error=f"Unsupported provider: {req.provider}")
    try:
        await checker(req.api_key)
        return ValidateKeyResponse(provider=req.provider, valid=True)
    except Exception as e:
        logger.info("Key validation failed for provider=%s: %s", req.provider, e)
        return ValidateKeyResponse(provider=req.provider, valid=False, error=str(e))
