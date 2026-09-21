"""Probe which embedding models a customer's key can actually encode.

/models lists everything LiteLLM's catalog knows for a provider, which is
broader than what the encoding pipeline can embed — e.g. it lists
voyage-multimodal-* models the Voyage text-embed path rejects. Selecting one
used to fail silently, days later, deep in the encoding server (the whole
Step Functions run aborts before the store step, so nothing reaches Milvus).

This endpoint closes that gap: for each LiteLLM candidate it makes a tiny
one-token embed against the SAME vendor endpoint the production encoder uses
(`encoding_library.get_embedding_model`'s dispatch), so a model that probes OK
is exactly one the pipeline can embed. The key is passed in the Authorization
header per request — we deliberately do NOT set VOYAGE_API_KEY / OPENAI_API_KEY
in the environment (this server is shared and its own /retrieve query-embedding
reads those env vars, so mutating them would leak the probe key into concurrent
requests).

Verdicts per model:
  - 200                    -> supported
  - 401 / 403              -> the KEY is bad, not the model -> whole-vendor error
  - 400 / 404 / 422        -> definitively unsupported (drop it)
  - 429 / 5xx / timeout    -> inconclusive (caller keeps the model's prior verdict)
"""
import asyncio
import logging

import httpx
from fastapi import APIRouter
from pydantic import BaseModel

from encoding_library.utils.model_registry import is_contextualized_model
from routes.models import _list_provider_models

logger = logging.getLogger(__name__)

router = APIRouter()

# One-token probe input; cheapest authenticated embed there is.
_PROBE_TEXT = "a"
# Bounded fan-out so a wide catalog (~26 voyage models) can't open 26 sockets
# at once, and per-probe timeout so one slow model can't stall the request.
_MAX_CONCURRENCY = 8
_PROBE_TIMEOUT_S = 20


class ProbeVendorCredentials(BaseModel):
    provider: str  # "voyage" | "openai"
    api_key: str


class ProbeModelsRequest(BaseModel):
    vendors: list[ProbeVendorCredentials]


class VendorProbeResult(BaseModel):
    provider: str
    # Models the key embedded successfully (200).
    supported: list[str] = []
    # Models whose probe was transient/uncertain (429/5xx/timeout) — the caller
    # should keep whatever verdict it had for these, not drop them.
    inconclusive: list[str] = []
    # Set when the key itself failed auth, or the provider is unknown. When
    # present, supported/inconclusive are empty and the caller keeps its prior
    # list untouched.
    error: str | None = None


class ProbeModelsResponse(BaseModel):
    vendor_results: list[VendorProbeResult]


def _endpoint_and_payload(provider: str, model: str) -> tuple[str, dict]:
    """The exact vendor endpoint + minimal payload the production encoder uses.

    Mirrors encoding_library.get_embedding_model: voyage-context-* goes to the
    contextualized-embeddings endpoint; every other voyage model and all openai
    models go to the standard embeddings endpoint.
    """
    if provider == "voyage":
        if is_contextualized_model(model):
            return (
                "https://api.voyageai.com/v1/contextualizedembeddings",
                {"model": model, "inputs": [[_PROBE_TEXT]], "input_type": "document"},
            )
        return (
            "https://api.voyageai.com/v1/embeddings",
            {"model": model, "input": [_PROBE_TEXT]},
        )
    if provider == "openai":
        return (
            "https://api.openai.com/v1/embeddings",
            {"model": model, "input": _PROBE_TEXT},
        )
    raise ValueError(f"Unsupported embedding provider: {provider}")


# Per-model verdicts.
_SUPPORTED = "supported"
_UNSUPPORTED = "unsupported"
_INCONCLUSIVE = "inconclusive"
_AUTH_ERROR = "auth_error"


async def _probe_one(
    client: httpx.AsyncClient, provider: str, model: str, api_key: str
) -> str:
    try:
        url, payload = _endpoint_and_payload(provider, model)
    except ValueError:
        return _UNSUPPORTED
    try:
        resp = await client.post(
            url,
            headers={"Authorization": f"Bearer {api_key}"},
            json=payload,
            timeout=_PROBE_TIMEOUT_S,
        )
    except (httpx.TimeoutException, httpx.TransportError) as e:
        logger.info("probe %s/%s inconclusive (transport): %s", provider, model, e)
        return _INCONCLUSIVE

    if resp.status_code == 200:
        return _SUPPORTED
    if resp.status_code in (401, 403):
        return _AUTH_ERROR
    if resp.status_code in (400, 404, 422):
        return _UNSUPPORTED
    # 429, 5xx, and anything else: can't conclude the model is unsupported.
    logger.info("probe %s/%s inconclusive (HTTP %s)", provider, model, resp.status_code)
    return _INCONCLUSIVE


async def _probe_vendor(vendor: ProbeVendorCredentials) -> VendorProbeResult:
    provider = vendor.provider
    try:
        candidates = _list_provider_models(provider, "embedding")
    except Exception as e:
        logger.warning("probe: cannot list candidates for %s: %s", provider, e)
        return VendorProbeResult(provider=provider, error=f"unknown provider: {provider}")
    if not candidates:
        return VendorProbeResult(provider=provider, error=f"no embedding models for provider {provider}")

    sem = asyncio.Semaphore(_MAX_CONCURRENCY)

    async with httpx.AsyncClient() as client:
        async def _guarded(model: str) -> tuple[str, str]:
            async with sem:
                return model, await _probe_one(client, provider, model, vendor.api_key)

        verdicts = await asyncio.gather(*(_guarded(m) for m in candidates))

    # A single auth failure means the key is bad, not any one model — the
    # caller should keep its stored list rather than wipe it.
    if any(v == _AUTH_ERROR for _, v in verdicts):
        return VendorProbeResult(provider=provider, error="authentication failed")

    supported = sorted(m for m, v in verdicts if v == _SUPPORTED)
    inconclusive = sorted(m for m, v in verdicts if v == _INCONCLUSIVE)
    logger.info(
        "probe %s: %d supported, %d unsupported, %d inconclusive",
        provider, len(supported),
        sum(1 for _, v in verdicts if v == _UNSUPPORTED), len(inconclusive),
    )
    return VendorProbeResult(provider=provider, supported=supported, inconclusive=inconclusive)


@router.post("/probe-embedding-models")
async def probe_embedding_models(req: ProbeModelsRequest) -> ProbeModelsResponse:
    results = await asyncio.gather(*(_probe_vendor(v) for v in req.vendors))
    return ProbeModelsResponse(vendor_results=list(results))
