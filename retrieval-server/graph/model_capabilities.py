"""Per-model multimodal capabilities (PDF input, vision).

The retrieval-server is the component that actually constructs the model client
(graph/llm_factory.get_llm) and already carries LiteLLM's capability catalog, so
it owns capability resolution; the proxy consumes what /providers publishes.

Source of truth is `litellm.model_cost` — the same bundled/refreshed snapshot
that already backs /providers, /models and /model_metadata. Each record carries
`supports_pdf_input` and `supports_vision` alongside the `supports_function_calling`
that /providers already reads. The map lags for brand-new or BYOK/long-tail
models (a miss returns {} → everything False), so two safety layers sit on top:

  1. a native-provider short-circuit — every current Anthropic (Claude) model
     reads PDFs natively, even when the snapshot hasn't caught up;
  2. a small explicit override table for models the map gets wrong.

Both the per-turn dispatch (graph/nodes/llm_node) and the /providers catalog
read through here, so the UI hint and the actual behavior never diverge.
"""
import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ModelCaps:
    """Whether a model reads an attached PDF natively, and whether it accepts
    images (which gates the page-image PDF fallback for non-native models)."""
    pdf_input: bool
    vision: bool


# Providers whose chat models reliably accept native PDF document blocks even
# when the LiteLLM snapshot lags behind a release. Only Anthropic is blanket-true
# here: every current Claude reads PDFs. OpenAI and Gemini have a mix of
# PDF-capable and text-only models, so they are read from the map (plus overrides)
# rather than assumed.
_PDF_NATIVE_PROVIDERS = {"anthropic"}

# Explicit corrections for models the LiteLLM map is missing or wrong about.
# Keyed by the bare (prefix-stripped) model id OR the full id. Each value is
# (pdf_input, vision); use None for a field to defer to the map / short-circuit.
_OVERRIDES: dict[str, tuple[bool | None, bool | None]] = {
    # Example — uncomment/extend as the map proves stale for a model you ship:
    # "gpt-4o": (True, True),
}


def _apply_overrides(provider: str, model: str, pdf: bool, vision: bool) -> ModelCaps:
    stripped = model.removeprefix(f"{provider}/") if provider else model
    ov = _OVERRIDES.get(stripped) or _OVERRIDES.get(model)
    if ov is not None:
        if ov[0] is not None:
            pdf = ov[0]
        if ov[1] is not None:
            vision = ov[1]
    return ModelCaps(pdf_input=pdf, vision=vision)


def caps_from_info(provider: str | None, model: str | None, info: dict) -> ModelCaps:
    """Resolve caps from an already-fetched litellm.model_cost record. Lets
    /providers (which iterates the catalog) reuse the exact same logic without a
    second dict lookup."""
    provider = (provider or "").lower()
    model = model or ""
    pdf = bool(info.get("supports_pdf_input", False)) or provider in _PDF_NATIVE_PROVIDERS
    vision = bool(info.get("supports_vision", False))
    return _apply_overrides(provider, model, pdf, vision)


def model_capabilities(provider: str | None, model: str | None) -> ModelCaps:
    """Caps for one (provider, model). Fetches the litellm.model_cost record
    (trying both the bare and `<provider>/<model>` keys) and resolves through
    caps_from_info. Any lookup failure degrades to the safe default (no native
    PDF, no vision) — which, because a text-extraction fallback always exists,
    simply routes the PDF through extraction rather than failing."""
    provider_l = (provider or "").lower()
    model = model or ""
    try:
        import litellm
        info = (
            litellm.model_cost.get(model)
            or litellm.model_cost.get(f"{provider_l}/{model}")
            or {}
        )
    except Exception as e:  # pragma: no cover - defensive; litellm import/map issues
        logger.warning("model_capabilities: litellm lookup failed for %s/%s: %s", provider_l, model, e)
        info = {}
    return caps_from_info(provider_l, model, info)
