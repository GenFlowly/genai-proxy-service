"""Model listing backed by LiteLLM's model catalog.

Models are read from litellm's maintained catalog (model_cost /
models_by_provider) instead of live vendor list APIs. The catalog carries
per-model capability metadata (mode, supported_endpoints), which the vendors'
own list APIs mostly lack — this is what lets us filter voice models reliably.

Consequences of the catalog approach:
  - no vendor API calls and no API key needed to list models
  - the list reflects what LiteLLM knows, not what a specific key can access
  - brand-new models appear when the litellm dependency is updated
"""
import logging

from fastapi import APIRouter
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter()

def _is_known_provider(provider: str) -> bool:
    # Any provider in the LiteLLM catalog is callable: natively for the tier
    # in graph/llm_factory.NATIVE_PROVIDERS, via ChatLiteLLM for the rest.
    # (voyage is embedding-only and only ever asked for with
    # capability="embedding".)
    import litellm
    return provider in litellm.models_by_provider


class VendorCredentials(BaseModel):
    provider: str  # "openai" | "anthropic" | "gemini" | "voyage"
    # Unused with the LiteLLM catalog (kept for wire compatibility with callers)
    api_key: str = ""
    # "all" — every model LiteLLM lists for the provider (no filtering).
    # "voice" — only realtime voice models (served via /v1/realtime-style APIs).
    # "embedding" — only embedding models (mode == "embedding" in the catalog).
    capability: str = "all"


class ListModelsRequest(BaseModel):
    vendors: list[VendorCredentials]


class VendorModels(BaseModel):
    provider: str
    models: list[str]


class ListModelsResponse(BaseModel):
    vendor_models: list[VendorModels]


def _is_voice_model(model_name: str, model_cost: dict) -> bool:
    info = model_cost.get(model_name) or {}
    return (
        info.get("mode") == "realtime"
        or "/v1/realtime" in (info.get("supported_endpoints") or [])
    )


def _is_embedding_model(model_name: str, model_cost: dict) -> bool:
    return (model_cost.get(model_name) or {}).get("mode") == "embedding"


def _list_provider_models(provider: str, capability: str) -> list[str]:
    # litellm is imported lazily: it's a heavy import and only needed here
    import litellm

    names = litellm.models_by_provider.get(provider) or set()
    if capability == "voice":
        names = {n for n in names if _is_voice_model(n, litellm.model_cost)}
    elif capability == "embedding":
        names = {n for n in names if _is_embedding_model(n, litellm.model_cost)}

    # Catalog names may be provider-prefixed (e.g. "gemini/gemini-2.5-flash");
    # strip the prefix and dedupe so ids are directly usable as llm_model values.
    return sorted({n.removeprefix(f"{provider}/") for n in names})


def _list_for_vendor(vendor: VendorCredentials) -> VendorModels:
    if not _is_known_provider(vendor.provider):
        logger.warning("Unsupported provider '%s' in /models request", vendor.provider)
        return VendorModels(provider=vendor.provider, models=[])
    try:
        models = _list_provider_models(vendor.provider, vendor.capability)
        logger.info(
            "Listed %d models from LiteLLM catalog for provider=%s capability=%s",
            len(models), vendor.provider, vendor.capability,
        )
        return VendorModels(provider=vendor.provider, models=models)
    except Exception as e:
        logger.warning("Failed to list models for provider=%s: %s", vendor.provider, e)
        return VendorModels(provider=vendor.provider, models=[])


@router.post("/models")
async def list_models(req: ListModelsRequest) -> ListModelsResponse:
    return ListModelsResponse(vendor_models=[_list_for_vendor(v) for v in req.vendors])
