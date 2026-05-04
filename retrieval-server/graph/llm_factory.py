import logging
from typing import Optional

from langchain_core.language_models import BaseChatModel

logger = logging.getLogger(__name__)

_DEFAULTS = {
    "anthropic": "claude-sonnet-4-6",
    "openai": "gpt-4o",
    "gemini": "gemini-1.5-pro",
}


def get_llm(provider: str, credentials: dict, model: Optional[str] = None, max_tokens: int = 4096) -> BaseChatModel:
    resolved_model = model or _DEFAULTS.get(provider)
    logger.info("LLM factory: provider=%s model=%s max_tokens=%d", provider, resolved_model, max_tokens)

    if provider == "anthropic":
        from langchain_anthropic import ChatAnthropic
        key = credentials.get("anthropic_api_key", "")
        if not key:
            logger.error("LLM factory: anthropic_api_key is MISSING in credentials")
        else:
            logger.info("LLM factory: anthropic_api_key present (len=%d)", len(key))
        return ChatAnthropic(
            model=resolved_model,
            api_key=key,
            max_tokens=max_tokens,
        )

    elif provider == "openai":
        from langchain_openai import ChatOpenAI
        key = credentials.get("openai_api_key", "")
        if not key:
            logger.error("LLM factory: openai_api_key is MISSING in credentials")
        else:
            logger.info("LLM factory: openai_api_key present (len=%d)", len(key))
        return ChatOpenAI(
            model=resolved_model,
            api_key=key,
            max_tokens=max_tokens,
        )

    elif provider == "gemini":
        from langchain_google_genai import ChatGoogleGenerativeAI
        key = credentials.get("gemini_api_key", "")
        if not key:
            logger.error("LLM factory: gemini_api_key is MISSING in credentials")
        else:
            logger.info("LLM factory: gemini_api_key present (len=%d)", len(key))
        return ChatGoogleGenerativeAI(
            model=resolved_model,
            google_api_key=key,
            max_tokens=max_tokens,
        )

    else:
        logger.error("LLM factory: unsupported provider '%s'", provider)
        raise ValueError(f"Unsupported LLM provider: {provider}")
