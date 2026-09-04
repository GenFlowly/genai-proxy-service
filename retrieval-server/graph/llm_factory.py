import logging
from typing import Optional

from langchain_core.language_models import BaseChatModel

logger = logging.getLogger(__name__)

_DEFAULTS = {
    "anthropic": "claude-sonnet-4-6",
    "openai": "gpt-4o",
    "gemini": "gemini-1.5-pro",
}


def get_llm(
    provider: str,
    credentials: dict,
    model: Optional[str] = None,
    max_tokens: int = 4096,
    betas: Optional[list[str]] = None,
) -> BaseChatModel:
    resolved_model = model or _DEFAULTS.get(provider)
    logger.info("LLM factory: provider=%s model=%s max_tokens=%d betas=%s", provider, resolved_model, max_tokens, betas)

    if provider == "anthropic":
        from langchain_anthropic import ChatAnthropic
        key = credentials.get("anthropic_api_key", "")
        if not key:
            logger.error("LLM factory: anthropic_api_key is MISSING in credentials")
        else:
            logger.info("LLM factory: anthropic_api_key present (len=%d)", len(key))
        kwargs = {"betas": betas} if betas else {}
        return ChatAnthropic(
            model=resolved_model,
            api_key=key,
            max_tokens=max_tokens,
            **kwargs,
        )

    elif provider == "openai":
        from langchain_openai import ChatOpenAI
        key = credentials.get("openai_api_key", "")
        if not key:
            logger.error("LLM factory: openai_api_key is MISSING in credentials")
        else:
            logger.info("LLM factory: openai_api_key present (len=%d)", len(key))
        kwargs = {}
        # gpt-5 family: reasoning is on by default and /v1/chat/completions
        # rejects function tools + reasoning ("use /v1/responses or set
        # reasoning_effort to 'none'"). The Responses API supports both, so
        # route the whole family there. langchain-openai only auto-routes the
        # -pro variants it knows about, which lags behind new model releases.
        if (resolved_model or "").startswith("gpt-5"):
            kwargs["use_responses_api"] = True
        return ChatOpenAI(
            model=resolved_model,
            api_key=key,
            max_tokens=max_tokens,
            **kwargs,
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
