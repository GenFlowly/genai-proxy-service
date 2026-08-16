"""Per-model metadata (token limits + pricing) fetched live.

Unlike /models (LiteLLM catalog, no vendor calls), this endpoint talks to the
vendors' own model APIs with real API keys, so the result reflects what the
key can actually access — including models newer than the installed litellm.

Limit sources per provider:
  - anthropic: GET /v1/models exposes max_tokens (output cap) and
    max_input_tokens per model.
  - gemini:    ListModels exposes outputTokenLimit / inputTokenLimit.
  - openai:    GET /v1/models returns ids only; limits are filled in from
    the LiteLLM price map (max_output_tokens / max_input_tokens).

Pricing: no vendor model API exposes pricing, so it always comes from
LiteLLM's price map. The map is fetched live from GitHub (the same JSON
litellm bundles, but current — new model prices appear without a dependency
bump) with the bundled litellm.model_cost as offline fallback. Costs are
normalized to USD per 1M tokens.
"""
import asyncio
import logging
import time
from typing import Optional

import httpx
from fastapi import APIRouter
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter()

_VENDOR_TIMEOUT_S = 30.0

# LiteLLM's continuously-updated price/limits map (same schema as
# litellm.model_cost, which is a bundled snapshot of this file)
_LITELLM_PRICE_MAP_URL = (
    "https://raw.githubusercontent.com/BerriAI/litellm/main/"
    "model_prices_and_context_window.json"
)
_PRICE_MAP_TTL_S = 6 * 60 * 60
_price_map_cache: dict = {}
_price_map_fetched_at: float = 0.0


class VendorKey(BaseModel):
    provider: str  # "openai" | "anthropic" | "gemini"
    api_key: str


class ModelMetadataRequest(BaseModel):
    vendors: list[VendorKey]


class ModelMetadata(BaseModel):
    model: str
    max_output_tokens: Optional[int] = None
    max_input_tokens: Optional[int] = None
    # USD per 1M tokens, from the LiteLLM price map (vendor APIs carry no pricing)
    input_cost_per_mtok: Optional[float] = None
    output_cost_per_mtok: Optional[float] = None
    cache_read_cost_per_mtok: Optional[float] = None
    cache_write_cost_per_mtok: Optional[float] = None


class VendorModelMetadata(BaseModel):
    provider: str
    models: list[ModelMetadata]
    error: Optional[str] = None


class ModelMetadataResponse(BaseModel):
    vendor_models: list[VendorModelMetadata]


async def _get_price_map(client: httpx.AsyncClient) -> dict:
    """The live LiteLLM price map, cached in-process; bundled catalog on failure."""
    global _price_map_cache, _price_map_fetched_at

    now = time.monotonic()
    if _price_map_cache and now - _price_map_fetched_at < _PRICE_MAP_TTL_S:
        return _price_map_cache
    try:
        resp = await client.get(_LITELLM_PRICE_MAP_URL)
        resp.raise_for_status()
        fetched = resp.json()
        if isinstance(fetched, dict) and fetched:
            _price_map_cache = fetched
            _price_map_fetched_at = now
            logger.info("Fetched live LiteLLM price map (%d models)", len(fetched))
            return _price_map_cache
        logger.warning("Live LiteLLM price map response was empty/malformed")
    except Exception as e:
        logger.warning("Failed to fetch live LiteLLM price map: %s", e)

    if _price_map_cache:  # stale live copy beats the bundled snapshot
        return _price_map_cache
    import litellm

    return litellm.model_cost


def _model_info(price_map: dict, provider: str, model: str) -> dict:
    return price_map.get(model) or price_map.get(f"{provider}/{model}") or {}


def _catalog_limits(price_map: dict, provider: str, model: str) -> tuple[Optional[int], Optional[int]]:
    """(max_output_tokens, max_input_tokens) from the price map, or Nones."""
    info = _model_info(price_map, provider, model)
    max_out = info.get("max_output_tokens") or info.get("max_tokens")
    max_in = info.get("max_input_tokens")
    return (
        int(max_out) if max_out else None,
        int(max_in) if max_in else None,
    )


def _per_mtok(info: dict, key: str) -> Optional[float]:
    per_token = info.get(key)
    if per_token is None:
        return None
    try:
        return round(float(per_token) * 1_000_000, 6)
    except (TypeError, ValueError):
        return None


def _catalog_pricing(price_map: dict, provider: str, model: str) -> dict:
    """Pricing kwargs for ModelMetadata, normalized to USD per 1M tokens."""
    info = _model_info(price_map, provider, model)
    return {
        "input_cost_per_mtok": _per_mtok(info, "input_cost_per_token"),
        "output_cost_per_mtok": _per_mtok(info, "output_cost_per_token"),
        "cache_read_cost_per_mtok": _per_mtok(info, "cache_read_input_token_cost"),
        "cache_write_cost_per_mtok": _per_mtok(info, "cache_creation_input_token_cost"),
    }


async def _fetch_anthropic(
    client: httpx.AsyncClient, api_key: str, price_map: dict
) -> list[ModelMetadata]:
    models: list[ModelMetadata] = []
    after_id: Optional[str] = None
    headers = {"x-api-key": api_key, "anthropic-version": "2023-06-01"}
    while True:
        params: dict = {"limit": 100}
        if after_id:
            params["after_id"] = after_id
        resp = await client.get(
            "https://api.anthropic.com/v1/models", headers=headers, params=params
        )
        resp.raise_for_status()
        body = resp.json()
        for item in body.get("data", []):
            model_id = item.get("id")
            if not model_id:
                continue
            # Newer API versions return the caps directly; older ones don't
            max_out = item.get("max_tokens")
            max_in = item.get("max_input_tokens")
            if not max_out or not max_in:
                ll_out, ll_in = _catalog_limits(price_map, "anthropic", model_id)
                max_out = max_out or ll_out
                max_in = max_in or ll_in
            models.append(
                ModelMetadata(
                    model=model_id,
                    max_output_tokens=max_out,
                    max_input_tokens=max_in,
                    **_catalog_pricing(price_map, "anthropic", model_id),
                )
            )
        if not body.get("has_more"):
            break
        after_id = body.get("last_id")
        if not after_id:
            break
    return models


async def _fetch_gemini(
    client: httpx.AsyncClient, api_key: str, price_map: dict
) -> list[ModelMetadata]:
    models: list[ModelMetadata] = []
    page_token: Optional[str] = None
    while True:
        params: dict = {"key": api_key, "pageSize": 200}
        if page_token:
            params["pageToken"] = page_token
        resp = await client.get(
            "https://generativelanguage.googleapis.com/v1beta/models", params=params
        )
        resp.raise_for_status()
        body = resp.json()
        for item in body.get("models", []):
            if "generateContent" not in (item.get("supportedGenerationMethods") or []):
                continue
            model_id = (item.get("name") or "").removeprefix("models/")
            if not model_id:
                continue
            max_out = item.get("outputTokenLimit")
            max_in = item.get("inputTokenLimit")
            if not max_out or not max_in:
                ll_out, ll_in = _catalog_limits(price_map, "gemini", model_id)
                max_out = max_out or ll_out
                max_in = max_in or ll_in
            models.append(
                ModelMetadata(
                    model=model_id,
                    max_output_tokens=max_out,
                    max_input_tokens=max_in,
                    **_catalog_pricing(price_map, "gemini", model_id),
                )
            )
        page_token = body.get("nextPageToken")
        if not page_token:
            break
    return models


async def _fetch_openai(
    client: httpx.AsyncClient, api_key: str, price_map: dict
) -> list[ModelMetadata]:
    resp = await client.get(
        "https://api.openai.com/v1/models",
        headers={"Authorization": f"Bearer {api_key}"},
    )
    resp.raise_for_status()
    models: list[ModelMetadata] = []
    for item in resp.json().get("data", []):
        model_id = item.get("id")
        if not model_id:
            continue
        # OpenAI's list API carries no limit or pricing fields — the price map
        # is the only source for both
        max_out, max_in = _catalog_limits(price_map, "openai", model_id)
        models.append(
            ModelMetadata(
                model=model_id,
                max_output_tokens=max_out,
                max_input_tokens=max_in,
                **_catalog_pricing(price_map, "openai", model_id),
            )
        )
    return models


_FETCHERS = {
    "anthropic": _fetch_anthropic,
    "gemini": _fetch_gemini,
    "openai": _fetch_openai,
}


async def _fetch_for_vendor(
    client: httpx.AsyncClient, vendor: VendorKey, price_map: dict
) -> VendorModelMetadata:
    fetcher = _FETCHERS.get(vendor.provider)
    if fetcher is None:
        logger.warning("Unsupported provider '%s' in /models/metadata request", vendor.provider)
        return VendorModelMetadata(
            provider=vendor.provider, models=[], error=f"unsupported provider: {vendor.provider}"
        )
    try:
        models = await fetcher(client, vendor.api_key, price_map)
        with_limits = sum(1 for m in models if m.max_output_tokens)
        with_pricing = sum(1 for m in models if m.input_cost_per_mtok is not None)
        logger.info(
            "Model metadata for provider=%s: %d models (%d with output limits, %d with pricing)",
            vendor.provider, len(models), with_limits, with_pricing,
        )
        return VendorModelMetadata(provider=vendor.provider, models=models)
    except Exception as e:
        logger.warning("Failed to fetch model metadata for provider=%s: %s", vendor.provider, e)
        return VendorModelMetadata(provider=vendor.provider, models=[], error=str(e))


@router.post("/models/metadata")
async def model_metadata(req: ModelMetadataRequest) -> ModelMetadataResponse:
    async with httpx.AsyncClient(timeout=_VENDOR_TIMEOUT_S) as client:
        price_map = await _get_price_map(client)
        results = await asyncio.gather(
            *(_fetch_for_vendor(client, v, price_map) for v in req.vendors)
        )
    return ModelMetadataResponse(vendor_models=list(results))
