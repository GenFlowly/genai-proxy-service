"""BYOK vendor catalog.

Lists every provider the platform can call: the native tier (first-party
langchain-* integrations, see graph/llm_factory.NATIVE_PROVIDERS) plus the
whole LiteLLM catalog — any provider here works once the customer stores an
API key for it. Chat-capable models only; per-model supportsTools comes from
the LiteLLM capability metadata so clients can hint where agentic features
may degrade.

The catalog is static per litellm version, so it is computed once per
process.
"""
import logging

from fastapi import APIRouter
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter()

# Brand-correct names for common providers; everything else is title-cased
# from the LiteLLM id.
_DISPLAY_NAMES = {
    "openai": "OpenAI",
    "anthropic": "Anthropic",
    "gemini": "Google Gemini",
    "xai": "xAI",
    "mistral": "Mistral",
    "groq": "Groq",
    "deepseek": "DeepSeek",
    "cohere": "Cohere",
    "perplexity": "Perplexity",
    "together_ai": "Together AI",
    "fireworks_ai": "Fireworks AI",
    "nvidia_nim": "NVIDIA NIM",
    "openrouter": "OpenRouter",
    "cerebras": "Cerebras",
    "sambanova": "SambaNova",
    "moonshot": "Moonshot (Kimi)",
    "ai21": "AI21",
    "meta_llama": "Meta Llama",
    "aiml": "AI/ML API",
    "deepinfra": "DeepInfra",
    "novita": "Novita",
    "nebius": "Nebius",
    "zai": "Z.ai",
}

# Aggregators/clouds whose keys are not a simple pasteable API key, or
# providers that are not text-chat vendors at all — excluded from the BYOK
# catalog even when litellm lists chat models for them.
_EXCLUDED_PROVIDERS = {
    "azure", "azure_ai", "azure_text", "azure_anthropic",
    "bedrock", "bedrock_mantle", "amazon_nova",
    "vertex_ai", "watsonx", "oci", "snowflake", "databricks",
    "sagemaker", "sagemaker_chat",
    "ollama", "ollama_chat",  # local runtimes, no key to bring
    "palm", "chatgpt", "text-completion-openai",  # legacy aliases
    # OAuth device-flow auth, not a pasteable API key. Also: litellm's
    # capability helpers trigger the interactive login for this provider —
    # never probe it.
    "github_copilot",
}


class ProviderModel(BaseModel):
    name: str
    supportsTools: bool
    # Whether an uploaded PDF reaches the model natively (graph/capabilities.py);
    # otherwise it gets the extracted text. The UI shows a hint when false.
    supportsPdfInput: bool = False
    # Token limits + pricing (USD per 1M tokens) from the LiteLLM price map —
    # lets the proxy's AIModelCatalog price long-tail vendors without needing
    # a vendor API key. Null when the map has no figure.
    maxInputTokens: int | None = None
    maxOutputTokens: int | None = None
    inputCostPerMTok: float | None = None
    outputCostPerMTok: float | None = None
    cacheReadCostPerMTok: float | None = None
    cacheWriteCostPerMTok: float | None = None
    inputAudioCostPerMTok: float | None = None
    outputAudioCostPerMTok: float | None = None
    cacheReadAudioCostPerMTok: float | None = None


class Provider(BaseModel):
    id: str
    displayName: str
    native: bool
    models: list[ProviderModel]


class ListProvidersResponse(BaseModel):
    providers: list[Provider]


def _display_name(provider: str) -> str:
    return _DISPLAY_NAMES.get(provider) or provider.replace("_", " ").title()


def _as_int(value) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _per_mtok(info: dict, key: str) -> float | None:
    per_token = info.get(key)
    if per_token is None:
        return None
    try:
        return round(float(per_token) * 1_000_000, 6)
    except (TypeError, ValueError):
        return None


def _build_catalog() -> ListProvidersResponse:
    import litellm
    from graph.capabilities import supports_pdf_input
    from graph.llm_factory import NATIVE_PROVIDERS

    native_ids = set(NATIVE_PROVIDERS) | {"openai", "anthropic", "gemini"}

    providers: list[Provider] = []
    for provider, models in litellm.models_by_provider.items():
        if provider in _EXCLUDED_PROVIDERS:
            continue
        # Keyed by stripped name: prefixed and bare catalog entries (e.g.
        # "deepseek/deepseek-chat" and "deepseek-chat") collapse to one model.
        chat_models_by_name: dict[str, ProviderModel] = {}
        for m in sorted(set(models)):
            info = litellm.model_cost.get(m) or {}
            # Some providers' catalog entries carry no mode at all
            # (together_ai, modelscope, ...) yet are chat LLMs — treat
            # mode-less as chat rather than dropping whole providers.
            if info.get("mode") not in ("chat", None):
                continue
            # Read the flag straight from the catalog dict —
            # litellm.supports_function_calling() runs provider code paths
            # and can even block on interactive auth (github_copilot).
            tools = bool(info.get("supports_function_calling", False))
            stripped = m.removeprefix(f"{provider}/")
            if stripped in chat_models_by_name:
                continue
            chat_models_by_name[stripped] = (
                ProviderModel(
                    name=stripped,
                    supportsTools=tools,
                    supportsPdfInput=supports_pdf_input(provider, stripped),
                    maxInputTokens=_as_int(info.get("max_input_tokens")),
                    maxOutputTokens=_as_int(info.get("max_output_tokens")),
                    inputCostPerMTok=_per_mtok(info, "input_cost_per_token"),
                    outputCostPerMTok=_per_mtok(info, "output_cost_per_token"),
                    cacheReadCostPerMTok=_per_mtok(info, "cache_read_input_token_cost"),
                    cacheWriteCostPerMTok=_per_mtok(info, "cache_creation_input_token_cost"),
                    inputAudioCostPerMTok=_per_mtok(info, "input_cost_per_audio_token"),
                    outputAudioCostPerMTok=_per_mtok(info, "output_cost_per_audio_token"),
                    cacheReadAudioCostPerMTok=_per_mtok(info, "cache_read_input_audio_token_cost"),
                )
            )
        if not chat_models_by_name:
            continue
        providers.append(Provider(
            id=provider,
            displayName=_display_name(provider),
            native=provider in native_ids,
            models=list(chat_models_by_name.values()),
        ))

    # Native tier first, then alphabetically by display name
    providers.sort(key=lambda p: (not p.native, p.displayName.lower()))
    logger.info(
        "Provider catalog built: %d providers (%d native)",
        len(providers), sum(1 for p in providers if p.native),
    )
    return ListProvidersResponse(providers=providers)


_catalog: ListProvidersResponse | None = None


@router.get("/providers")
def list_providers() -> ListProvidersResponse:
    global _catalog
    if _catalog is None:
        _catalog = _build_catalog()
    return _catalog
