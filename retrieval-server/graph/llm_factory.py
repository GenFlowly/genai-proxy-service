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

# Claude models that accept thinking={"type": "adaptive"} (the 4.6+/5
# families). Older models (haiku-4-5, sonnet-4-5, ...) only take the
# deprecated budget_tokens form, so thinking stays off for them. Internal
# request agents (titles, personas, memory extraction, …) control reasoning
# via their published node config's thinking_level, not via this allowlist.
_ADAPTIVE_THINKING_MODELS = (
    "claude-sonnet-4-6",
    "claude-sonnet-5",
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-fable-5",
    "claude-mythos-5",
)


def supports_adaptive_thinking(model: Optional[str]) -> bool:
    return bool(model) and model.startswith(_ADAPTIVE_THINKING_MODELS)


# Normalized thinking levels an LLM node may set via its "thinking_level"
# config. Each provider maps them to its native control below; unset (None)
# preserves the vendor's default behavior, so existing graphs are unaffected.
THINKING_LEVELS = ("none", "low", "medium", "high")

# OpenAI models whose API accepts reasoning_effort. "none"/"minimal" is a
# gpt-5-family concept; the o-series only accepts low/medium/high.
_OPENAI_REASONING_PREFIXES = ("gpt-5", "o1", "o3", "o4")


def get_llm(
    provider: str,
    credentials: dict,
    model: Optional[str] = None,
    max_tokens: int = 4096,
    betas: Optional[list[str]] = None,
    thinking: bool = False,
    thinking_level: Optional[str] = None,
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
        # Adaptive thinking: the model decides when/how much to reason before
        # answering; thinking tokens are billed inside output_tokens. Callers
        # opt in per call — it must stay off when tool_choice is forced or when
        # continuing a client-side tool loop whose replayed assistant turn has
        # no thinking blocks (the API rejects both). Only the 4.6+/5 families
        # accept the adaptive form. A node-level thinking_level of "none"
        # keeps thinking off; low/medium/high additionally pin the effort.
        if thinking_level != "none" and thinking and supports_adaptive_thinking(resolved_model):
            kwargs["thinking"] = {"type": "adaptive"}
            if thinking_level in ("low", "medium", "high"):
                kwargs["effort"] = thinking_level
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
        # Without store=False OpenAI keeps Responses API state for 30 days.
        # Nothing here reads it back: every call replays the whole history
        # (use_previous_response_id stays off).
        kwargs = {"store": False}
        # gpt-5 family: reasoning is on by default and /v1/chat/completions
        # rejects function tools + reasoning ("use /v1/responses or set
        # reasoning_effort to 'none'"). The Responses API supports both, so
        # route the whole family there. langchain-openai only auto-routes the
        # -pro variants it knows about, which lags behind new model releases.
        if (resolved_model or "").startswith("gpt-5"):
            kwargs["use_responses_api"] = True
            # Stored reasoning can't be referenced with store=False, so ask for
            # it encrypted: a tool round hands it back with the history.
            kwargs["include"] = ["reasoning.encrypted_content"]
        if thinking_level and (resolved_model or "").startswith(_OPENAI_REASONING_PREFIXES):
            if thinking_level == "none":
                if (resolved_model or "").startswith("gpt-5"):
                    kwargs["reasoning_effort"] = "minimal"
                else:
                    # o-series has no minimal/none — leave the vendor default
                    logger.info(
                        "LLM factory: thinking_level=none unsupported on %s — ignored",
                        resolved_model,
                    )
            else:
                kwargs["reasoning_effort"] = thinking_level
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
        kwargs = {}
        if thinking_level:
            model_id = resolved_model or ""
            if model_id.startswith("gemini-3"):
                # Gemini 3 exposes discrete thinking levels
                kwargs["thinking_level"] = (
                    "minimal" if thinking_level == "none" else thinking_level
                )
            elif model_id.startswith("gemini-2.5"):
                # Gemini 2.5 takes a token budget; 0 disables (2.5 Pro can't
                # disable — 128 is its documented floor)
                budget = {"none": 0, "low": 1024, "medium": 8192, "high": 24576}[thinking_level]
                if thinking_level == "none" and "pro" in model_id:
                    budget = 128
                kwargs["thinking_budget"] = budget
            else:
                logger.info(
                    "LLM factory: thinking_level unsupported on %s — ignored", model_id
                )
        return ChatGoogleGenerativeAI(
            model=resolved_model,
            google_api_key=key,
            max_tokens=max_tokens,
            max_retries=_MAX_RETRIES,
            **kwargs,
        )

    elif provider in NATIVE_PROVIDERS:
        if thinking_level:
            logger.info(
                "LLM factory: thinking_level not supported for provider %s — ignored",
                provider,
            )
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
        if thinking_level:
            logger.info(
                "LLM factory: thinking_level not supported for provider %s — ignored",
                provider,
            )
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
