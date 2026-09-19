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
    provider: str  # "openai" | "anthropic" | "gemini" | "voyage"
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

    # The client MUST outlive the await: google-genai auto-closes its aiohttp
    # session when the Client is garbage-collected, and the one-liner
    # `genai.Client(...).aio.models.list()` drops the only reference mid-call
    # — the in-flight request then dies with a bare AssertionError.
    client = genai.Client(api_key=api_key)
    try:
        await client.aio.models.list()
    finally:
        await client.aio.aclose()


async def _check_voyage(api_key: str) -> None:
    # Voyage has no list-models endpoint; a one-token embed is the cheapest
    # authenticated call there is.
    import httpx

    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.post(
            "https://api.voyageai.com/v1/embeddings",
            headers={"Authorization": f"Bearer {api_key}"},
            json={"input": ["ping"], "model": "voyage-4"},
        )
        response.raise_for_status()


# Popular providers whose api_base LiteLLM cannot resolve generically but
# that expose a standard bearer-authenticated GET /models.
_API_BASE_OVERRIDES = {
    "openrouter": "https://openrouter.ai/api/v1",
    "cohere": "https://api.cohere.com/v1",
    "cohere_chat": "https://api.cohere.com/v1",
}


def _openai_compat_base(provider: str) -> str | None:
    if provider in _API_BASE_OVERRIDES:
        return _API_BASE_OVERRIDES[provider]
    try:
        from litellm import get_llm_provider
        return get_llm_provider(model=f"{provider}/probe")[3]
    except Exception:
        return None


async def _check_via_litellm(provider: str, api_key: str) -> None:
    """Generic checker for any LiteLLM-cataloged provider.

    Preferred probe: the provider's list-models API (GET {base}/models with
    the bearer key) — auth-only, free, and independent of account balance, so
    a valid key on an out-of-credit account still validates. Providers with
    no resolvable OpenAI-compatible base (or whose /models endpoint is
    nonstandard) fall back to a one-token completion on their cheapest chat
    model; anything that authenticates counts as a valid key.
    """
    import litellm

    chat_models = [
        m for m in litellm.models_by_provider.get(provider, [])
        if (litellm.model_cost.get(m) or {}).get("mode") in ("chat", None)
    ]
    if not chat_models:
        raise ValueError(f"Unsupported provider: {provider}")

    base = _openai_compat_base(provider)
    if base:
        import httpx

        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
            url = f"{base.rstrip('/')}/models"
            response = await client.get(
                url, headers={"Authorization": f"Bearer {api_key}"}
            )
            if response.status_code in (401, 403):
                response.raise_for_status()
            if response.is_success:
                # Success only proves the key if the endpoint actually checks
                # auth — some providers serve /models publicly (OpenRouter).
                anonymous = await client.get(url)
                if not anonymous.is_success:
                    return
                logger.info(
                    "list-models endpoint for provider=%s is public; trying completion",
                    provider,
                )
            else:
                # Any other status = endpoint quirk (404, 405, ...) — the probe
                # is inconclusive about the KEY, fall through to the completion.
                logger.info(
                    "list-models probe inconclusive for provider=%s (%s); trying completion",
                    provider, response.status_code,
                )

    # Cheapest reasonable probe: prefer the model with the lowest input cost
    model = min(
        chat_models,
        key=lambda m: (litellm.model_cost.get(m) or {}).get("input_cost_per_token") or float("inf"),
    )
    if not model.startswith(f"{provider}/"):
        model = f"{provider}/{model}"
    await litellm.acompletion(
        model=model,
        api_key=api_key,
        messages=[{"role": "user", "content": "ping"}],
        max_tokens=1,
    )


_CHECKERS = {
    "openai": _check_openai,
    "anthropic": _check_anthropic,
    "gemini": _check_gemini,
    "voyage": _check_voyage,
}


@router.post("/validate-key")
async def validate_key(req: ValidateKeyRequest) -> ValidateKeyResponse:
    checker = _CHECKERS.get(req.provider)
    if checker is None:
        async def checker(api_key: str) -> None:
            await _check_via_litellm(req.provider, api_key)
    try:
        await checker(req.api_key)
        return ValidateKeyResponse(provider=req.provider, valid=True)
    except Exception as e:
        logger.info("Key validation failed for provider=%s: %s", req.provider, e)
        return ValidateKeyResponse(provider=req.provider, valid=False, error=str(e))
