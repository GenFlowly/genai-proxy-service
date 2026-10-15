"""What a model can take as input (plan 4.1).

supports_pdf_input decides whether an uploaded PDF goes to the model as a
native file block or as extracted text. LangChain's standard file block
becomes an Anthropic document, an OpenAI Chat file, an OpenAI Responses
input_file and Gemini inline_data. Every other provider class (the native
tier in graph/llm_factory.NATIVE_PROVIDERS and the LiteLLM tier) drops it,
errors, or passes an unsupported block through, so those get text even when
the LiteLLM catalog flags the model.

The flags come from LiteLLM's capability map (litellm.model_cost), read as
plain data: litellm's helper functions run provider code paths.
"""
import functools
import logging

logger = logging.getLogger(__name__)

_FILE_BLOCK_PROVIDERS = ("anthropic", "openai", "gemini")


@functools.lru_cache(maxsize=1)
def _model_cost() -> dict:
    try:
        import litellm

        return dict(litellm.model_cost)
    except Exception:  # pragma: no cover - litellm is a hard dependency
        logger.warning("litellm capability map unavailable")
        return {}


def _info(provider: str, model: str | None) -> dict:
    if not model:
        return {}
    costs = _model_cost()
    for key in (model, f"{provider}/{model}", model.split("/", 1)[-1]):
        info = costs.get(key)
        if isinstance(info, dict):
            return info
    return {}


def supports_pdf_input(provider: str | None, model: str | None) -> bool:
    """Whether `model` on `provider` reads a native PDF file block."""
    name = (provider or "").lower()
    if name == "anthropic":
        return True
    if name not in _FILE_BLOCK_PROVIDERS:
        return False
    return bool(_info(name, model).get("supports_pdf_input"))


def supports_vision(provider: str | None, model: str | None) -> bool:
    """Whether `model` takes images (page images of a scanned PDF). The three
    first-party providers' chat models all do unless the map says otherwise;
    elsewhere only when the map says so."""
    name = (provider or "").lower()
    info = _info(name, model)
    if name in _FILE_BLOCK_PROVIDERS:
        return info.get("supports_vision", True) is not False
    return bool(info.get("supports_vision"))
