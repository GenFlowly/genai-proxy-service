"""Anthropic extended-thinking gating: model support (llm_factory) and the
forced-tool_choice / tool-continuation gates (_build_llm_and_structured)."""

from graph.llm_factory import get_llm, supports_adaptive_thinking
from graph.nodes.llm_node import _build_llm_and_structured

_CREDS = {"anthropic_api_key": "sk-ant-test"}


def test_supports_adaptive_thinking_matrix():
    assert supports_adaptive_thinking("claude-sonnet-4-6")
    assert supports_adaptive_thinking("claude-opus-4-8")
    assert supports_adaptive_thinking("claude-fable-5")
    assert not supports_adaptive_thinking("claude-haiku-4-5")
    assert not supports_adaptive_thinking("claude-sonnet-4-5")
    assert not supports_adaptive_thinking(None)


def test_get_llm_enables_adaptive_thinking_on_supported_model():
    llm = get_llm("anthropic", _CREDS, "claude-sonnet-4-6", thinking=True)
    assert llm.thinking == {"type": "adaptive"}


def test_get_llm_thinking_off_by_default():
    llm = get_llm("anthropic", _CREDS, "claude-sonnet-4-6")
    assert llm.thinking is None


def test_get_llm_thinking_skipped_on_unsupported_model():
    # haiku-4-5 only supports the deprecated budget_tokens form — stays off
    llm = get_llm("anthropic", _CREDS, "claude-haiku-4-5", thinking=True)
    assert llm.thinking is None


def test_build_llm_allows_thinking_with_auto_tool_choice():
    for tool_choice in (None, "auto"):
        llm, _ = _build_llm_and_structured(
            "anthropic", _CREDS, "claude-sonnet-4-6", 4096, [],
            False, [], tool_choice, None, allow_thinking=True,
        )
        assert llm.thinking == {"type": "adaptive"}, tool_choice


def test_build_llm_blocks_thinking_on_forced_tool_choice():
    # Anthropic rejects forced tool use when thinking is enabled
    specs = [{
        "name": "get_weather",
        "description": "d",
        "parameters": {"type": "object", "properties": {}},
    }]
    for tool_choice in ("any", "get_weather"):
        llm, _ = _build_llm_and_structured(
            "anthropic", _CREDS, "claude-sonnet-4-6", 4096, [],
            True, specs, tool_choice, None, allow_thinking=True,
        )
        # bind_tools returns a RunnableBinding — inspect the bound model
        assert llm.bound.thinking is None, tool_choice


def test_build_llm_respects_allow_thinking_false():
    # tool-result continuations pass allow_thinking=False (no thinking blocks
    # to replay on the persisted assistant tool-call turn)
    llm, _ = _build_llm_and_structured(
        "anthropic", _CREDS, "claude-sonnet-4-6", 4096, [],
        False, [], None, None, allow_thinking=False,
    )
    assert llm.thinking is None


# ── thinking_level (normalized per-node knob) ────────────────────────────────

_OPENAI_CREDS = {"openai_api_key": "sk-test"}
_GEMINI_CREDS = {"gemini_api_key": "g-test"}


def test_thinking_level_anthropic_sets_adaptive_and_effort():
    llm = get_llm("anthropic", _CREDS, "claude-sonnet-4-6",
                  thinking=True, thinking_level="medium")
    assert llm.thinking == {"type": "adaptive"}
    assert llm.effort == "medium"


def test_thinking_level_none_disables_anthropic_thinking():
    # "none" wins even when the caller would otherwise enable thinking
    llm = get_llm("anthropic", _CREDS, "claude-sonnet-4-6",
                  thinking=True, thinking_level="none")
    assert llm.thinking is None
    assert llm.effort is None


def test_thinking_level_cannot_override_thinking_gate():
    # An explicit level never re-enables thinking where the caller gated it
    # off (forced tool_choice / tool-result replay constraints)
    llm = get_llm("anthropic", _CREDS, "claude-sonnet-4-6",
                  thinking=False, thinking_level="high")
    assert llm.thinking is None


def test_thinking_level_openai_gpt5_maps_to_reasoning_effort():
    llm = get_llm("openai", _OPENAI_CREDS, "gpt-5-mini", thinking_level="low")
    assert llm.reasoning_effort == "low"
    llm = get_llm("openai", _OPENAI_CREDS, "gpt-5-mini", thinking_level="none")
    assert llm.reasoning_effort == "minimal"


def test_thinking_level_openai_ignored_on_non_reasoning_model():
    llm = get_llm("openai", _OPENAI_CREDS, "gpt-4o", thinking_level="high")
    assert llm.reasoning_effort is None


def test_thinking_level_gemini_25_maps_to_budget():
    llm = get_llm("gemini", _GEMINI_CREDS, "gemini-2.5-flash", thinking_level="none")
    assert llm.thinking_budget == 0
    llm = get_llm("gemini", _GEMINI_CREDS, "gemini-2.5-flash", thinking_level="medium")
    assert llm.thinking_budget == 8192
    # 2.5 Pro cannot disable thinking — "none" clamps to its 128-token floor
    llm = get_llm("gemini", _GEMINI_CREDS, "gemini-2.5-pro", thinking_level="none")
    assert llm.thinking_budget == 128


def test_thinking_level_gemini_3_maps_to_level():
    llm = get_llm("gemini", _GEMINI_CREDS, "gemini-3-pro-preview", thinking_level="high")
    assert llm.thinking_level == "high"
    llm = get_llm("gemini", _GEMINI_CREDS, "gemini-3-pro-preview", thinking_level="none")
    assert llm.thinking_level == "minimal"


def test_thinking_level_unset_preserves_defaults():
    assert get_llm("openai", _OPENAI_CREDS, "gpt-5-mini").reasoning_effort is None
    assert get_llm("gemini", _GEMINI_CREDS, "gemini-2.5-flash").thinking_budget is None
    assert get_llm("anthropic", _CREDS, "claude-sonnet-4-6").effort is None
