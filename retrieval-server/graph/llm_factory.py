import logging
from typing import Optional

from langchain_core.language_models import BaseChatModel

logger = logging.getLogger(__name__)

_DEFAULTS = {
    "anthropic": "claude-sonnet-4-6",
    "openai": "gpt-4o",
    "gemini": "gemini-1.5-pro",
}

# Native tier of the BYOK vendor catalog: providers with a first-party
# langchain-* integration (each wraps the vendor's own SDK). openai/anthropic/
# gemini stay in dedicated branches below because they carry vendor-specific
# logic (betas, Responses-API routing). Everything else goes through LiteLLM.
# Keys are LiteLLM provider ids — the platform-wide canonical vendor ids.
# Values: (module, class, api-key kwarg — most accept the generic "api_key").
NATIVE_PROVIDERS = {
    "xai": ("langchain_xai", "ChatXAI", "api_key"),
    "mistral": ("langchain_mistralai", "ChatMistralAI", "api_key"),
    "groq": ("langchain_groq", "ChatGroq", "api_key"),
    "deepseek": ("langchain_deepseek", "ChatDeepSeek", "api_key"),
    "cohere": ("langchain_cohere", "ChatCohere", "cohere_api_key"),
    "perplexity": ("langchain_perplexity", "ChatPerplexity", "api_key"),
    "together_ai": ("langchain_together", "ChatTogether", "api_key"),
    "fireworks_ai": ("langchain_fireworks", "ChatFireworks", "api_key"),
    "nvidia_nim": ("langchain_nvidia_ai_endpoints", "ChatNVIDIA", "api_key"),
}

# LLM calls retry inside the vendor SDKs (exponential backoff on 429/5xx/
# connection errors, no retry on auth/4xx) rather than through
# encoding_library.utils.retry — re-issuing a generation from our layer can
# double-bill when the original request actually succeeded server-side.
_MAX_RETRIES = 3


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
            max_retries=_MAX_RETRIES,
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
            max_retries=_MAX_RETRIES,
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
            max_retries=_MAX_RETRIES,
        )

    elif provider in NATIVE_PROVIDERS:
        module_name, class_name, key_kwarg = NATIVE_PROVIDERS[provider]
        key = credentials.get(f"{provider}_api_key", "")
        if not key:
            logger.error("LLM factory: %s_api_key is MISSING in credentials", provider)
        try:
            import importlib
            cls = getattr(importlib.import_module(module_name), class_name)
            return cls(
                model=resolved_model,
                max_tokens=max_tokens,
                max_retries=_MAX_RETRIES,
                **{key_kwarg: key},
            )
        except Exception as e:
            # A native package that fails to import or construct must not take
            # the provider down — the LiteLLM path speaks its API too.
            logger.warning(
                "LLM factory: native %s (%s.%s) unavailable (%s); falling back to LiteLLM",
                provider, module_name, class_name, e,
            )
            return _litellm_llm(provider, credentials, resolved_model, max_tokens)

    else:
        # Long-tail BYOK providers: one normalized client over each vendor's
        # native API. Model ids are namespaced "<provider>/<model>".
        return _litellm_llm(provider, credentials, resolved_model, max_tokens)


def _litellm_llm(
    provider: str,
    credentials: dict,
    model: Optional[str],
    max_tokens: int,
) -> BaseChatModel:
    from langchain_litellm import ChatLiteLLM

    key = credentials.get(f"{provider}_api_key", "")
    if not key:
        logger.error("LLM factory: %s_api_key is MISSING in credentials", provider)
    if not model:
        raise ValueError(f"Provider '{provider}' requires an explicit model")
    logger.info("LLM factory: LiteLLM path provider=%s model=%s", provider, model)
    return ChatLiteLLM(
        model=f"{provider}/{model}",
        api_key=key,
        max_tokens=max_tokens,
        max_retries=_MAX_RETRIES,
    )
