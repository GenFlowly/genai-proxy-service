"""Embedding-model pricing catalog, for Cost and Usage's Embedding Models page.

routes/providers.py builds its catalog from litellm.model_cost but filters to
chat-mode entries only (`mode in ("chat", None)`), which drops every
embedding-mode entry. This mirrors that catalog-build pattern filtered the
other way, surfacing Voyage/OpenAI embedding pricing so genai-proxy-server's
ModelCatalogService can sync it into AIModelCatalog the same way it already
syncs chat-model pricing.

The catalog is static per litellm version, so it is computed once per process
(same as providers.py).
"""
import logging

from fastapi import APIRouter
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter()


class EmbeddingProviderModel(BaseModel):
    name: str
    # USD per 1M tokens from the LiteLLM price map. Null when the map has no
    # figure for this model (callers should skip syncing those rows).
    inputCostPerMTok: float | None = None


class EmbeddingProvider(BaseModel):
    id: str
    models: list[EmbeddingProviderModel]


class ListEmbeddingProvidersResponse(BaseModel):
    providers: list[EmbeddingProvider]


def _per_mtok(info: dict, key: str) -> float | None:
    per_token = info.get(key)
    if per_token is None:
        return None
    try:
        return round(float(per_token) * 1_000_000, 6)
    except (TypeError, ValueError):
        return None


# Embedding providers this platform actually supports (encoding_library's
# get_embedding_model only instantiates voyage/openai hosted encoders, plus a
# keyless local sentence-transformer that has no cost and no catalog need).
_SUPPORTED_PROVIDERS = {"voyage", "openai"}


def _build_catalog() -> ListEmbeddingProvidersResponse:
    import litellm

    providers: list[EmbeddingProvider] = []
    for provider, models in litellm.models_by_provider.items():
        if provider not in _SUPPORTED_PROVIDERS:
            continue
        models_by_name: dict[str, EmbeddingProviderModel] = {}
        for m in sorted(set(models)):
            info = litellm.model_cost.get(m) or {}
            if info.get("mode") != "embedding":
                continue
            stripped = m.removeprefix(f"{provider}/")
            if stripped in models_by_name:
                continue
            models_by_name[stripped] = EmbeddingProviderModel(
                name=stripped,
                inputCostPerMTok=_per_mtok(info, "input_cost_per_token"),
            )
        if not models_by_name:
            continue
        providers.append(EmbeddingProvider(id=provider, models=list(models_by_name.values())))

    logger.info(
        "Embedding provider catalog built: %d provider(s), %d model(s)",
        len(providers), sum(len(p.models) for p in providers),
    )
    return ListEmbeddingProvidersResponse(providers=providers)


_catalog: ListEmbeddingProvidersResponse | None = None


@router.get("/embedding-providers")
def list_embedding_providers() -> ListEmbeddingProvidersResponse:
    global _catalog
    if _catalog is None:
        _catalog = _build_catalog()
    return _catalog
