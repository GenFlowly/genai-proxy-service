import json
import logging
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from content_logging import LOG_USER_CONTENT, redact
from encoding_library.observability import count, observe
from graph.credentials import credentials_for, resolve_credentials
from graph.llm_factory import THINKING_LEVELS, get_llm
from graph.image_normalize import ImageLimits, ImageNormalizationError, limits_for_request, max_images_for_request
from graph.s3_images import image_for_llm
from graph.state import RetrievalState
from graph.tools_runtime import spec_context_for, specs_for
from graph import documents
from graph.pdf_metrics import record_truncated
from graph.truncation import cut_off_reason

import durable_runtime


logger = logging.getLogger(__name__)


# --- LLM construction + invocation (shared by the stateless and durable paths) ---

def _build_llm_and_structured(
    provider, credentials, effective_model, max_tokens, llm_betas,
    tools_bound, tool_specs, tool_choice, response_schema,
    allow_thinking=False, thinking_level=None,
):
    """Build the chat model (with tools / structured-output binding) for one call.
    Shared verbatim by the inline /retrieve path and the durable step so both
    produce an identical model."""
    # Anthropic extended (adaptive) thinking. Two hard API constraints gate it
    # here: (1) forced tool use (tool_choice "any" / a named tool) is rejected
    # when thinking is on; (2) callers must additionally pass
    # allow_thinking=False when replaying an assistant tool-call turn that has
    # no thinking blocks (client-side tool-result continuations — we persist
    # tool_calls JSON, not thinking blocks). In-graph TOOL_EXECUTOR loops are
    # fine: their AIMessages keep the thinking blocks in state.
    # thinking_level is the node's normalized reasoning knob ("none"/"low"/
    # "medium"/"high") — mapped per vendor in get_llm; the gates above still
    # win, so a level can never re-enable thinking where the API rejects it.
    thinking = allow_thinking and tool_choice in (None, "auto")
    llm = get_llm(
        provider, credentials, effective_model, max_tokens,
        betas=llm_betas or None, thinking=thinking, thinking_level=thinking_level,
    )
    if tools_bound:
        bind_kwargs = {"tool_choice": tool_choice} if tool_choice else {}
        llm = llm.bind_tools(tool_specs, **bind_kwargs)
    structured_llm = None
    if response_schema:
        # include_raw keeps the AIMessage (usage_metadata) alongside the parsed
        # object. Anthropic uses method="json_schema" (native grammar-constrained
        # decoding, needs a top-level title); others take the function-format spec.
        if provider == "anthropic":
            structured_llm = llm.with_structured_output(
                {"title": "structured_response", **response_schema},
                method="json_schema",
                include_raw=True,
            )
        else:
            structured_llm = llm.with_structured_output(
                {
                    "name": "structured_response",
                    "description": response_schema.get(
                        "description", "Respond with a single object in this exact JSON structure."
                    ),
                    "parameters": response_schema,
                },
                include_raw=True,
            )
    return llm, structured_llm


async def _invoke_llm(llm, structured_llm, messages):
    """Invoke the model, returning (response, parsed, parsing_error). Token
    streaming (on_chat_model_stream) surfaces through the outer astream_events on
    both paths — verified to survive inside a DBOS step."""
    if structured_llm is not None:
        wrapped = await structured_llm.ainvoke(messages)
        return wrapped["raw"], wrapped["parsed"], wrapped["parsing_error"]
    response = await llm.ainvoke(messages)
    return response, None, None


# Retry/backoff policy for the durable LLM step (P3). Retries transient vendor
# failures with exponential backoff; fails fast on non-retriable ones.
_LLM_STEP_MAX_ATTEMPTS = int(os.getenv("LLM_STEP_MAX_ATTEMPTS", "3"))
_LLM_STEP_INTERVAL_SEC = float(os.getenv("LLM_STEP_INTERVAL_SEC", "1.0"))
_LLM_STEP_BACKOFF_RATE = float(os.getenv("LLM_STEP_BACKOFF_RATE", "2.0"))

# Fail-fast markers: retrying these wastes time (the proxy has no failover mid-run).
_LLM_NONRETRIABLE_MARKERS = (
    "authentication", "unauthorized", "invalid api key", "api key not valid",
    "invalid_api_key", "401", "403", "permission denied",
    "context length", "context_length", "maximum context", "prompt is too long", "input is too long",
    "model_not_found", "does not exist", "not found", "404",
    "insufficient balance", "exceeded_current_quota", "billing", "suspended",
)
# Transient markers: brief spikes worth a backed-off retry.
_LLM_TRANSIENT_MARKERS = (
    "rate limit", "ratelimit", "429", "too many requests", "resource_exhausted",
    "timeout", "timed out", "connection", "econnreset", "connection reset",
    "temporarily unavailable", "overloaded", "unavailable", "503", "502", "500 internal",
)


def _is_transient_llm_error(e: BaseException) -> bool:
    """should_retry predicate for the durable LLM step. Non-retriable markers win
    (checked first) so a hard quota/auth/context error never burns retries;
    unknown errors are treated as non-transient (conservative)."""
    low = f"{type(e).__name__}: {e}".lower()
    if any(m in low for m in _LLM_NONRETRIABLE_MARKERS):
        return False
    transient = any(m in low for m in _LLM_TRANSIENT_MARKERS)
    if transient:
        logger.warning("Durable LLM step: transient error, will retry — %s", str(e)[:200])
    return transient


# Exactly-once LLM step for the durable /runs path (P2). Registered only when DBOS
# is constructed; on the stateless /retrieve path it's never used. Credentials are
# resolved from DynamoDB INSIDE the step (never a step input/output), so no secret
# is persisted to DBOS's system tables (DURABLE_AGENTS_DBOS_PLAN §5.5). On a
# crash/redeploy the memoized response replays instead of re-billing the vendor.
# retries_allowed + should_retry add bounded backoff on transient vendor failures
# (P3); a successful (possibly retried) call is still memoized exactly once.
if durable_runtime.dbos_constructed():
    from dbos import DBOS

    @DBOS.step(
        name="llm_invoke",
        retries_allowed=True,
        max_attempts=_LLM_STEP_MAX_ATTEMPTS,
        interval_seconds=_LLM_STEP_INTERVAL_SEC,
        backoff_rate=_LLM_STEP_BACKOFF_RATE,
        should_retry=_is_transient_llm_error,
    )
    async def _durable_llm_invoke(
        provider, customer_id, effective_model, max_tokens, llm_betas,
        tools_bound, tool_specs, tool_choice, response_schema, messages,
        allow_thinking=False, thinking_level=None,
    ):
        credentials = resolve_credentials(customer_id, provider)
        llm, structured_llm = _build_llm_and_structured(
            provider, credentials, effective_model, max_tokens, llm_betas,
            tools_bound, tool_specs, tool_choice, response_schema,
            allow_thinking=allow_thinking, thinking_level=thinking_level,
        )
        response, parsed, parsing_error = await _invoke_llm(llm, structured_llm, messages)
        return {"response": response, "parsed": parsed, "parsing_error": parsing_error}
else:
    _durable_llm_invoke = None


def _dbos_active() -> bool:
    """True only while executing inside a DBOS workflow (the durable /runs path)."""
    if _durable_llm_invoke is None:
        return False
    from dbos import DBOS
    return DBOS.workflow_id is not None


def _build_context(results: list) -> str:
    if not results:
        return "No relevant context found."
    parts = []
    for i, r in enumerate(results, 1):
        entity = r.get("entity", {})
        title = entity.get("title") or entity.get("subject", "")
        note = entity.get("note_value", "")
        parts.append(f"[{i}] {title}\n{note}".strip())
    return "\n\n".join(parts)


def _build_chunks_text(results: list) -> str:
    return "\n".join(
        f"[{i}] {r['entity'].get('note_value') or r['entity'].get('title', '')}"
        for i, r in enumerate(results)
    )


# Travels inside {web_context} so it reaches whichever node renders it — the
# response generator's system prompt is customer-controlled and can't be
# amended per-node. Override or disable via WEB_SEARCH config
# "citation_instruction" ("" disables).
_DEFAULT_CITATION_INSTRUCTION = (
    "When your answer uses information from the sources above, cite them inline "
    "with bracketed numbers matching the source list, e.g. [1] or [2][3]."
)


def _build_web_context(results: list, answer: str | None, citation_instruction: str | None = None) -> str:
    if not results and not answer:
        return "No web search results available."
    parts = []
    if answer:
        parts.append(f"Web search summary: {answer}")
    for i, r in enumerate(results, 1):
        title = r.get("title", "")
        url = r.get("url", "")
        content = r.get("content", "")
        parts.append(f"[{i}] {title} ({url})\n{content}".strip())
    if results:
        instruction = _DEFAULT_CITATION_INSTRUCTION if citation_instruction is None else citation_instruction
        if instruction:
            parts.append(instruction)
    return "\n\n".join(parts)


def _make_system(text: str, cache: bool) -> SystemMessage:
    if cache:
        return SystemMessage(content=[{"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}])
    return SystemMessage(content=text)


def _make_human(content, cache: bool) -> HumanMessage:
    """content is either a plain string or a list of multimodal blocks."""
    if not cache:
        return HumanMessage(content=content)
    if isinstance(content, str):
        return HumanMessage(content=[{"type": "text", "text": content, "cache_control": {"type": "ephemeral"}}])
    # Block list: Anthropic wants cache_control on the last block of the prefix
    blocks = [dict(b) for b in content]
    if blocks:
        blocks[-1] = {**blocks[-1], "cache_control": {"type": "ephemeral"}}
    return HumanMessage(content=blocks)


@dataclass(frozen=True)
class RequestImagePlan:
    """How this request's images are sent: per-image limits, and the oldest
    history attachments left out because the request can't carry them all."""
    limits: ImageLimits
    omitted: frozenset = frozenset()


_OMITTED_IMAGE_NOTE = "[earlier image omitted to fit the model's request size limit]"


def plan_request_images(state: dict, provider: str | None, with_history: bool,
                        reserved_bytes: int = 0) -> RequestImagePlan:
    """Every image sent — the current turn's, replayed history's and tool
    results' (Claude-only, see _tool_messages) — shares the vendor's request
    size limit. If there are more than the vendor can take
    (max_images_for_request), the OLDEST history attachments are replaced by a
    text note, in blocks; current-turn and tool-result images are always sent."""
    current = len(state.get("query_images") or [])
    tool_results = list(state.get("query_tool_results") or [])
    history_keys: list[str] = []
    if with_history:
        history = state.get("conversation_history") or []
        for turn in history[:-1]:
            if turn.get("role", "user") == "user":
                history_keys.extend(img.get("s3_key", "") for img in (turn.get("images") or []))
                tool_results.extend(turn.get("tool_results") or [])
    tool_images = 0
    if (provider or "").lower() == "anthropic":
        tool_images = sum(
            1 for r in tool_results for img in (r.get("images") or []) if not img.get("omitted")
        )
    cap = max_images_for_request(provider, reserved_bytes) if reserved_bytes else max_images_for_request(provider)
    overflow = len(history_keys) - max(0, cap - current - tool_images)
    omitted: frozenset = frozenset()
    if overflow > 0:
        # Leave out whole blocks of a quarter of the cap: the replayed history
        # (and so the vendor's prompt cache over it) then only changes every
        # few image turns instead of on each one.
        step = max(1, cap // 4)
        omitted = frozenset(history_keys[: min(len(history_keys), -(-overflow // step) * step)])
    count = current + tool_images + len(history_keys) - len(omitted)
    if reserved_bytes:
        return RequestImagePlan(limits_for_request(provider, count, reserved_bytes), omitted)
    return RequestImagePlan(limits_for_request(provider, count), omitted)


async def _image_blocks(images: list, strict: bool, limits: ImageLimits | None = None,
                        omitted: frozenset = frozenset()) -> list:
    """
    Resolve [{s3_key, media_type}, ...] into data-URL image blocks. The
    image_url form is normalized by langchain-anthropic/-openai/-google-genai
    into each provider's native image format, so one shape covers all vendors.

    Uploads may be any image type/size: image_for_llm sniffs the real format
    and converts/downscales within `limits` (request_image_limits; see
    graph/image_normalize.py), so the data URL carries the media type of the
    bytes actually sent — the declared img["media_type"] is not trusted.

    strict=True (current turn): a failure fails the request; an
    ImageNormalizationError message reaches the user verbatim (streaming.py).
    strict=False (history replay): failed images degrade to a text note.
    """
    if limits is None:
        limits = limits_for_request(None, len(images or []))
    blocks = []
    for img in images or []:
        s3_key = img.get("s3_key", "")
        if s3_key in omitted:
            blocks.append({"type": "text", "text": _OMITTED_IMAGE_NOTE})
            continue
        try:
            b64, media_type = await image_for_llm(s3_key, limits)
            blocks.append({"type": "image_url", "image_url": {"url": f"data:{media_type};base64,{b64}"}})
        except Exception as e:
            log = logger.warning if isinstance(e, ImageNormalizationError) else logger.error
            log("Failed to prepare attachment image %s: %s", s3_key, e)
            if strict:
                raise
            blocks.append({"type": "text", "text": "[attached image unavailable]"})
    return blocks


def _user_content(text: str, image_blocks: list):
    """Plain string when there are no images, otherwise text + image blocks."""
    if not image_blocks:
        return text
    return [{"type": "text", "text": text}, *image_blocks]


# Beta header each Anthropic-native tool version requires. A tool's options may
# carry an explicit "anthropic_beta" to override/extend this mapping.
_NATIVE_TOOL_BETAS = {
    "computer_20250124": "computer-use-2025-01-24",
    "bash_20250124": "computer-use-2025-01-24",
    "computer_20241022": "computer-use-2024-10-22",
    "text_editor_20241022": "computer-use-2024-10-22",
    "bash_20241022": "computer-use-2024-10-22",
}


def _build_tool_specs(tools: list, provider: str) -> tuple[list, list]:
    """
    Convert API tool definitions into bind_tools specs. Returns (specs, betas).

    Function tools (no `type`) become OpenAI function-tool dicts — LangChain
    accepts that one format on all three vendor classes. Native tools (`type`
    set, e.g. computer_20250124) pass through untranslated with their options
    merged in; they are Anthropic-only and may require a beta header.
    """
    specs, betas = [], []
    for t in tools:
        native_type = t.get("type")
        if native_type and native_type != "function":
            if provider != "anthropic":
                raise ValueError(
                    f"Native tool type '{native_type}' is supported on Anthropic (Claude) only"
                )
            spec = {"type": native_type, "name": t["name"], **(t.get("options") or {})}
            beta = spec.pop("anthropic_beta", None) or _NATIVE_TOOL_BETAS.get(native_type)
            if beta and beta not in betas:
                betas.append(beta)
            specs.append(spec)
        else:
            specs.append({
                "type": "function",
                "function": {
                    "name": t["name"],
                    "description": t.get("description", ""),
                    "parameters": t.get("parameters") or {"type": "object", "properties": {}},
                },
            })
    return specs, betas


def _normalize_tool_choice(tool_choice: str | None) -> str | None:
    """Map the API's tool_choice to LangChain's cross-provider vocabulary."""
    if not tool_choice or tool_choice == "auto":
        return "auto" if tool_choice else None
    if tool_choice in ("required", "any"):
        return "any"  # LangChain normalizes "any" per provider ("required" on OpenAI)
    return tool_choice  # a specific tool name


def _file_context(turn: dict, omit_documents: bool = False) -> str:
    """Notes naming a history turn's non-image files (plan 3.1), so the model
    knows which files exist and can pass their ids to revise_pdf,
    read_pdf_source or read_attachment: a generated file on an assistant turn,
    an uploaded document on a user turn. "" when the turn has none.
    omit_documents: uploaded PDFs are left out because the caller sends them
    as document blocks (graph/documents.py)."""
    notes = []
    for f in turn.get("files") or []:
        if not isinstance(f, dict):
            continue
        if omit_documents and f.get("origin") != "generated" and \
                (f.get("media_type") or "").startswith("application/pdf"):
            continue
        name = f.get("filename") or "file"
        if f.get("origin") == "generated":
            notes.append(f"[Generated file: {name}, id={f.get('attachment_id', '')}]")
        else:
            notes.append(f"[Attached file: {name}, id={f.get('attachment_id', '')}]")
    return "\n".join(notes)


def _with_file_context(content: str, turn: dict, omit_documents: bool = False) -> str:
    note = _file_context(turn, omit_documents)
    if not note:
        return content
    return f"{content}\n\n{note}" if content else note


def _history_ai_message(content: str, tool_calls: list, cache: bool) -> AIMessage:
    """Assistant turn that made tool calls — rebuilt so vendors see native tool-use blocks."""
    normalized = [
        {"name": c.get("name", ""), "args": c.get("args") or {}, "id": c.get("id", ""), "type": "tool_call"}
        for c in tool_calls
    ]
    return AIMessage(content=content or "", tool_calls=normalized)


async def _tool_messages(tool_results: list, provider: str, limits: ImageLimits | None = None) -> list:
    """
    Build ToolMessages, resolving any attached images (e.g. computer-use
    screenshots) into content blocks. Images arrive as base64 data or an S3 key;
    `omitted` entries are historical screenshots stripped at persistence time.
    Image blocks are Anthropic-only — other providers get a text placeholder.
    """
    if limits is None:
        limits = plan_request_images({"query_tool_results": tool_results}, provider, with_history=False).limits
    out = []
    for r in tool_results or []:
        text = r.get("content", "")
        images = r.get("images") or []
        if not images:
            out.append(ToolMessage(content=text, tool_call_id=r.get("tool_call_id", "")))
            continue
        blocks: list = [{"type": "text", "text": text}] if text else []
        for img in images:
            if img.get("omitted"):
                blocks.append({"type": "text", "text": "[screenshot omitted from history]"})
                continue
            if provider != "anthropic":
                blocks.append({"type": "text", "text": "[image tool result omitted — images in tool results are Claude-only]"})
                continue
            media_type = img.get("media_type") or "image/png"
            data = img.get("data")
            if not data and img.get("s3_key"):
                try:
                    # Normalized like attachments; the media type is the sniffed one.
                    data, media_type = await image_for_llm(img["s3_key"], limits)
                except Exception as e:
                    logger.error("Failed to fetch tool-result image %s: %s", img.get("s3_key"), e)
                    blocks.append({"type": "text", "text": "[image unavailable]"})
                    continue
            if data:
                blocks.append({"type": "image_url", "image_url": {"url": f"data:{media_type};base64,{data}"}})
        out.append(ToolMessage(content=blocks or "", tool_call_id=r.get("tool_call_id", "")))
    return out


def _content_summary(content) -> str:
    """Log-safe rendering: image and document blocks become placeholders,
    never base64."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict) and b.get("type") == "image_url":
                parts.append("<image>")
            elif isinstance(b, dict) and b.get("type") == "file":
                parts.append(f"<pdf {b.get('filename') or ''}>".replace(" >", ">"))
            elif isinstance(b, dict):
                parts.append(str(b.get("text", b)))
            else:
                parts.append(str(b))
        return " ".join(parts)
    return str(content)


def _make_ai(text: str, cache: bool) -> AIMessage:
    if cache:
        return AIMessage(content=[{"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}])
    return AIMessage(content=text)


# State fields nodes may write into directly; any other output_key routes into
# the free-form `scratch` channel, readable from later templates/conditions.
_DIRECT_OUTPUT_KEYS = {
    "generated_response",
    "rewritten_query",
    "ranked_results",
    "retrieval_results",
    "query_intent",
    "needs_rewrite",
    "needs_more_context",
    "web_search_results",
    "web_search_answer",
    "error",
    "tool_calls",
}


# Prompt/response excerpts surfaced in the client's thinking panel.
_TRACE_TEXT_LIMIT = 1500


def _text_of(content) -> str:
    """Plain text of an AIMessage content (string or block list)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            b.get("text", "") if isinstance(b, dict) else str(b) for b in content
        )
    return str(content)


def _subagent_listing(state: dict) -> str:
    """The 'available agent types' block appended to the system prompt when
    spawn_agent is bound — the model dispatches by reading these descriptions
    (profiles are data in the TOOL_EXECUTOR node config; the built-in general
    profile is always available)."""
    from graph.subagent import GENERAL_PROFILE

    profiles: list = []
    for cfg in (state.get("node_configs") or {}).values():
        if isinstance(cfg, dict) and cfg.get("subagents"):
            profiles = [p for p in cfg["subagents"] if isinstance(p, dict) and p.get("name")]
            break
    if not any(p.get("name") == "general" for p in profiles):
        profiles = [GENERAL_PROFILE, *profiles]
    lines = "\n".join(f"- {p['name']}: {p.get('description', '')}" for p in profiles)
    return (
        "\n\nYou can delegate self-contained tasks with the spawn_agent tool. "
        f"Available agent types:\n{lines}"
    )


# ── Loop-message compaction (agent loops that outgrow the context window) ────
#
# When a turn's accumulated tool exchanges (loop_messages) pass a token
# threshold, the OLDER rounds are folded into one LLM-written summary — kept in
# scratch so the fold happens once per threshold crossing, not per iteration —
# and only the summary plus the newest round(s) are replayed to the model.
# Whole rounds (assistant turn + its tool results) are folded as a unit, so
# tool_call_id pairing in what remains is intact by construction. The
# summarization call runs through the durable LLM step on /runs (exactly-once
# billed); on failure the round degrades to clipped tool results rather than
# crashing mid-run, and the fold is retried next iteration.

_DEFAULT_COMPACTION_THRESHOLD_TOKENS = 40_000
_COMPACTION_MAX_TOKENS = 1500
# Rough chars→tokens for threshold checks; precision is not load-bearing.
_CHARS_PER_TOKEN = 4

_COMPACTION_SYSTEM = (
    "You compress an AI agent's tool-use history so the agent can keep "
    "working with less context. Write a dense, factual summary (under 800 "
    "words) that preserves: every finding and fact, with its inline [n] "
    "citation markers and source URLs; decisions made and why; open questions "
    "and dead ends; scratch file paths mentioned (fs paths); and what each "
    "remaining task needs. Drop raw payloads, boilerplate, and repetition. "
    "Output only the summary."
)

_SUMMARY_PREFIX = "[Summary of my earlier tool activity this turn]\n"


# Tool-call arguments are clipped to this many characters when rounds are
# serialized for the compaction summary (plan 3.5): a generate_pdf call
# carries a whole document.
_SERIALIZED_ARGS_CHARS = 2_000


def _args_json(call: dict) -> str:
    return json.dumps(call.get("args") or {}, default=str)


def _estimate_tokens(messages: list[dict], extra: str = "") -> int:
    """Rough token count of replayed loop messages, tool-call arguments
    included: an argument-heavy round (a long document passed to
    generate_pdf or fs_write) must count toward compaction too (plan 3.5)."""
    chars = sum(
        len(m.get("content") or "") + 40 + sum(len(_args_json(c)) for c in m.get("tool_calls") or [])
        for m in messages
    ) + len(extra)
    return chars // _CHARS_PER_TOKEN


def _clip_args(text: str) -> str:
    if len(text) <= _SERIALIZED_ARGS_CHARS:
        return text
    return f"{text[:_SERIALIZED_ARGS_CHARS]}... ({len(text):,} chars)"


def _serialize_rounds(prior_summary: str, messages: list[dict]) -> str:
    parts = []
    if prior_summary:
        parts.append(f"Previous summary (fold its content in):\n{prior_summary}")
    for m in messages:
        if m.get("role") == "assistant":
            calls = ", ".join(
                f"{c.get('name')}({_clip_args(_args_json(c))})"
                for c in m.get("tool_calls") or []
            )
            parts.append(f"ASSISTANT: {m.get('content') or ''}\nCALLED: {calls}")
        else:
            parts.append(f"TOOL RESULT: {(m.get('content') or '')[:6000]}")
    return "\n\n".join(parts)


def _usage_of(response) -> dict:
    meta = getattr(response, "usage_metadata", None) or {}
    details = meta.get("input_token_details") or {}
    output_details = meta.get("output_token_details") or {}
    return {
        "input_tokens": meta.get("input_tokens", 0),
        "output_tokens": meta.get("output_tokens", 0),
        "total_tokens": meta.get("total_tokens", 0),
        "cache_read_tokens": details.get("cache_read", 0),
        "cache_creation_tokens": details.get("cache_creation", 0),
        "reasoning_tokens": output_details.get("reasoning", 0),
    }


async def _summarize_for_compaction(
    state: dict, config: dict, serialized: str, use_durable: bool
) -> tuple[str, dict]:
    """One summarization LLM call. Returns (summary_text, usage); raises on
    failure — the caller owns degradation."""
    provider = state["llm_provider"]
    model = config.get("compaction_model") or state.get("llm_model")
    messages = [
        SystemMessage(content=_COMPACTION_SYSTEM),
        HumanMessage(content=serialized),
    ]
    llm_start = time.perf_counter()
    try:
        if use_durable:
            out = await _durable_llm_invoke(
                provider, state["customer_id"], model, _COMPACTION_MAX_TOKENS,
                [], False, [], None, None, messages,
            )
            response = out["response"]
        else:
            llm = get_llm(provider, credentials_for(state), model, _COMPACTION_MAX_TOKENS)
            response = await llm.ainvoke(messages)
    except Exception:
        count("llm_request_total", status="error", vendor=provider, model=model,
              source=state.get("request_source") or "conversation", operation="compaction")
        raise
    count("llm_request_total", status="ok", vendor=provider, model=model,
          source=state.get("request_source") or "conversation", operation="compaction")
    observe("llm_request_duration_seconds", time.perf_counter() - llm_start, vendor=provider)
    return _text_of(response.content), _usage_of(response)


async def _compact_loop_messages(
    state: dict, config: dict, loop_msgs: list[dict], use_durable: bool
) -> tuple[list[dict], dict, dict | None]:
    """Returns (messages_to_replay, scratch_update, compaction_usage)."""
    prior = (state.get("scratch") or {}).get("compaction") or {}
    upto = int(prior.get("upto") or 0)
    summary = prior.get("summary") or ""
    if upto > len(loop_msgs):
        # Defensive: scratch from an inconsistent state — ignore it.
        upto, summary = 0, ""
    active = loop_msgs[upto:]

    def with_summary(messages: list[dict]) -> list[dict]:
        if not summary:
            return messages
        return [
            {"role": "assistant", "content": _SUMMARY_PREFIX + summary, "tool_calls": []},
            *messages,
        ]

    threshold = int(
        config.get("compaction_threshold_tokens") or _DEFAULT_COMPACTION_THRESHOLD_TOKENS
    )
    if _estimate_tokens(active, summary) < threshold:
        return with_summary(active), {}, None

    # Newest round stays verbatim; everything before it is folded.
    last_assistant = max(
        (i for i, m in enumerate(active) if m.get("role") == "assistant"),
        default=None,
    )
    if not last_assistant:  # None, or 0 == the newest round is all there is
        return with_summary(active), {}, None
    to_fold, keep = active[:last_assistant], active[last_assistant:]

    try:
        new_summary, usage = await _summarize_for_compaction(
            state, config, _serialize_rounds(summary, to_fold), use_durable
        )
        count("agent_compaction_total", status="ok")
    except Exception as e:
        count("agent_compaction_total", status="error")
        logger.error("Compaction summarization failed — degrading to clipping: %s", e)
        clipped = [
            {**m, "content": f"{(m.get('content') or '')[:400]} …[truncated]"}
            if m.get("role") == "tool" and len(m.get("content") or "") > 400
            else m
            for m in to_fold
        ]
        # No scratch update: the fold is retried on the next iteration.
        return with_summary(clipped + keep), {}, None

    logger.info(
        "Compaction: folded %d loop message(s) into a %d-char summary",
        len(to_fold), len(new_summary),
    )
    replay = [
        {"role": "assistant", "content": _SUMMARY_PREFIX + new_summary.strip(), "tool_calls": []},
        *keep,
    ]
    return replay, {"compaction": {"summary": new_summary.strip(), "upto": upto + last_assistant}}, usage


def _trace_entry(node_label: str, prompt: str, response) -> dict:
    text = response if isinstance(response, str) else json.dumps(response, default=str)
    return {"trace": [{
        "node": node_label,
        "prompt": (prompt or "")[:_TRACE_TEXT_LIMIT],
        "response": (text or "")[:_TRACE_TEXT_LIMIT],
    }]}


def _route_output(key, value) -> dict:
    """State-update dict for one output: first-class field or scratch entry."""
    if key in _DIRECT_OUTPUT_KEYS:
        return {key: value}
    return {"scratch": {key: value}}


def _merge_outputs(updates: list[dict]) -> dict:
    """Merge routed outputs, combining their scratch sub-dicts."""
    merged: dict = {}
    scratch: dict = {}
    for update in updates:
        scratch.update(update.pop("scratch", {}) or {})
        merged.update(update)
    if scratch:
        merged["scratch"] = scratch
    return merged


# Optional template sections: {?field}...{/field} renders its body only when
# `field` has a real value (non-empty retrieval results for {?context}, web
# results for {?web_context}, a non-blank string / non-empty list otherwise).
_SECTION_RE = re.compile(r"\{\?(\w+)\}(.*?)\{/\1\}", re.DOTALL)


def _render_template(template: str, state: dict) -> str:
    """
    Replace {field_name} placeholders with values from state, scratch or
    computed variables. {?field}...{/field} blocks are optional sections,
    dropped entirely when the field has no real value — e.g.
    "{?context}Context:\n{context}\n\n{/context}Question: {query}" skips the
    whole Context section when retrieval found nothing.
    """
    ranked = state.get("ranked_results") or state.get("retrieval_results", [])
    web_results = state.get("web_search_results", [])
    web_answer = state.get("web_search_answer")
    computed = {
        "context": _build_context(ranked),
        "query": state.get("rewritten_query") or state.get("original_query", ""),
        "chunks_text": _build_chunks_text(state.get("retrieval_results", [])),
        "web_context": _build_web_context(
            web_results,
            web_answer,
            state.get("node_configs", {}).get("WEB_SEARCH", {}).get("citation_instruction"),
        ),
        "current_date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
    }
    scalars = lambda d: {k: v for k, v in d.items() if isinstance(v, (str, int, float, bool))}  # noqa: E731
    scratch = state.get("scratch", {}) or {}
    all_vars = {**scalars(scratch), **scalars(state), **computed}

    # Presence of a field for {?field} sections: the computed vars render
    # placeholder text even when empty, so test the underlying data instead.
    def has_value(name: str) -> bool:
        if name == "context":
            return bool(ranked)
        if name == "web_context":
            return bool(web_results or web_answer)
        if name == "chunks_text":
            return bool(state.get("retrieval_results"))
        val = scratch.get(name, state.get(name))
        if val is None:
            return name in all_vars and bool(str(all_vars[name]).strip())
        if isinstance(val, str):
            return bool(val.strip())
        if isinstance(val, (list, dict)):
            return bool(val)
        return bool(val)

    template = _SECTION_RE.sub(
        lambda m: m.group(2) if has_value(m.group(1)) else "", template
    )

    def replace(match):
        val = all_vars.get(match.group(1), "")
        return str(val) if val is not None else ""

    return re.sub(r"\{(\w+)\}", replace, template)


def make_llm_node(agent_type: str, node_id: str | None = None):
    """
    Returns an async LangGraph node function driven entirely by DDB config.

    Config keys (all optional — sane defaults apply):
      system_prompt                (str)  — SystemMessage content
      input_template               (str)  — HumanMessage with {state_field} placeholders.
                                            Special vars: {query}, {context}, {chunks_text}, {web_context}
      output_key                   (str)  — state field to write the response into
      response_format              (str)  — "text" | "json" | "json_indices"
      json_output_mapping          (dict) — {"llm_key": "state_key"} for response_format=json
      json_indices_source_key      (str)  — state list to reorder for response_format=json_indices
      include_conversation_history (bool) — prepend prior turns before the user message
      model_override               (str)  — override the request-level llm_model
      thinking_level               (str)  — "none" | "low" | "medium" | "high":
                                            normalized reasoning depth, mapped to the
                                            serving vendor's native control (OpenAI
                                            reasoning_effort, Anthropic adaptive
                                            thinking + effort, Gemini thinking
                                            budget/level). Unset keeps each vendor's
                                            default behavior.

    Note: system_prompt and model_override are ignored when output_key is
    "generated_response" — response generators always use the request's resolved
    instruction as system prompt and the request's llm_model. thinking_level IS
    honored on response generators.
    """
    async def node(state: RetrievalState) -> dict:
        # Config keyed by node identity first — the same node type can appear
        # multiple times with different configs — then by type (fallback and
        # statically-built graphs).
        configs = state.get("node_configs", {})
        config = (configs.get(node_id) if node_id else None) or configs.get(agent_type, {})

        input_template = config.get("input_template", "{original_query}")
        output_key = config.get("output_key")
        is_response_node = (output_key == "generated_response")

        # Response generators always take their persona from the request's resolved
        # instruction and their model from the request's aiConfig — node-level
        # system_prompt/model_override are not honored for them.
        if is_response_node:
            system_prompt = state.get("request_system_prompt") or "You are a helpful assistant."
            # Learned user memories (MEMORY node) ride on the persona.
            memories_block = state.get("memories_block")
            if memories_block:
                system_prompt = f"{system_prompt}\n\n{memories_block}"
            # Harness scaffolding (agent-loop discipline: planning, tool use,
            # delegation, stop conditions) PRECEDES the customer persona — the
            # persona says who the agent is, the harness says how it works.
            # Data, not code: resolved from the node config (inline
            # harness_prompt, or a harness_instruction_id resolved upstream in
            # routes/_build_node_configs), so it is editable without a deploy.
            harness_prompt = (config.get("harness_prompt") or "").strip()
            if harness_prompt:
                system_prompt = f"{harness_prompt}\n\n{system_prompt}"
            # Ground the model in the current date so it can judge whether its own
            # knowledge is stale, and — when a web_search tool is bound — nudge it to
            # search rather than answer time-sensitive questions from training data.
            today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            system_prompt = f"{system_prompt}\n\nThe current date is {today} (UTC)."
            if "spawn_agent" in (state.get("builtin_tools") or []):
                system_prompt += _subagent_listing(state)
            if "web_search" in (state.get("builtin_tools") or []):
                system_prompt += (
                    " When answering well depends on current, recent, or post-training "
                    "information (news, prices, releases, events, or anything framed as "
                    "'latest'/'current'/'today'), use the web_search tool and base your "
                    "answer on the results, preferring the most recent sources. If web "
                    "results conflict with your prior knowledge, trust the newer results "
                    "and note when information may be outdated."
                )
            # Tool-call preambles: without this, reasoning models (OpenAI's in
            # particular) deliberate in their hidden reasoning channel and attach
            # tool calls to an EMPTY message, so the thinking panel shows bare
            # call signatures with no stated motive. One narrated sentence per
            # round gives every vendor the "why I'm searching" visibility some
            # models (Grok, often Claude) already provide by habit. The sentence
            # is surfaced as the thinking step's `reasoning` field and recorded
            # in loop_messages; tool_executor clears generated_response after
            # each round so it can never stand in for the final answer.
            if state.get("builtin_tools") or state.get("tools"):
                system_prompt += (
                    "\n\nWhenever you decide to call one or more tools, first write a "
                    "single short sentence telling the user what you are about to do "
                    "and why (for example: \"Let me look up the current property list "
                    "to get an accurate count.\"), then make the call(s) in that same "
                    "turn. One sentence only — it announces the lookup, it is never a "
                    "substitute for the full answer once the results are in."
                )
            model_override = None
        else:
            system_prompt = config.get("system_prompt", "You are a helpful assistant.")
            model_override = config.get("model_override")

        # Per-turn token budget (agent loops): once the run's accumulated usage
        # crosses max_turn_tokens, this call binds NO tools and instructs the
        # model to answer with what it has — a clean exit, not a mid-turn
        # abort. The graph's maxIterations stays the loop-count backstop.
        budget_exhausted = False
        if is_response_node:
            max_turn_tokens = int(config.get("max_turn_tokens") or 0)
            if max_turn_tokens:
                spent = (state.get("usage") or {}).get("total_tokens", 0)
                if spent >= max_turn_tokens:
                    budget_exhausted = True
                    logger.warning(
                        "Node %s: turn token budget exhausted (%d >= %d) — forcing a final answer",
                        agent_type, spent, max_turn_tokens,
                    )
                    system_prompt += (
                        "\n\nYour tool budget for this turn is exhausted. Do not "
                        "call any more tools — give your best final answer now "
                        "from what you already have, and say plainly what you "
                        "could not verify."
                    )
        thinking_level = config.get("thinking_level")
        if is_response_node and state.get("request_thinking_level"):
            # The end user's per-request choice (AI-config widget / vendor
            # settings) wins over the agent author's node config — the same
            # precedence the request's model already has on response
            # generators. Pipeline nodes keep their node-level setting.
            thinking_level = state.get("request_thinking_level")
        if thinking_level is not None and thinking_level not in THINKING_LEVELS:
            logger.warning(
                "Node %s: invalid thinking_level %r (expected one of %s) — ignored",
                agent_type, thinking_level, ", ".join(THINKING_LEVELS),
            )
            thinking_level = None
        response_format = config.get("response_format", "text")
        json_output_mapping: dict = config.get("json_output_mapping", {})
        json_indices_source_key: str = config.get("json_indices_source_key", "retrieval_results")
        include_history: bool = config.get("include_conversation_history", True)

        # Short-circuit: skip LLM call if source list for json_indices is empty
        if response_format == "json_indices":
            source = state.get(json_indices_source_key, [])
            if not source:
                logger.info("Node %s: source list is empty — skipping LLM call", agent_type)
                return {**_route_output(output_key, []), "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}}

        effective_model = model_override or state.get("llm_model")

        # Structured output: a caller-supplied JSON Schema the response must
        # conform to. Only the response generator honors it. Enforced through
        # LangChain's with_structured_output, which maps to each vendor's
        # native mechanism (OpenAI json_schema/function calling, Anthropic
        # forced tool use, Gemini function calling) — the model cannot emit
        # free-form prose. Mutually exclusive with tools (validated upstream).
        response_schema = state.get("response_schema") if is_response_node and response_format == "text" else None

        # Caller-defined tools bind only to the plain-text response generator;
        # JSON-format nodes and pipeline nodes never see them. Native Anthropic
        # tools (computer use etc.) may require beta headers, which must be set
        # when the client is created — so specs are built before get_llm.
        # Built-in tools (graph_tools registry, enabled via the graph's
        # TOOL_EXECUTOR node) bind alongside them — their calls are executed
        # in-graph by the TOOL_EXECUTOR node instead of exiting to the caller.
        tools = state.get("tools") or []
        builtin_names = state.get("builtin_tools") or []
        if budget_exhausted:
            tools, builtin_names = [], []
        if is_response_node and builtin_names:
            # Resolved from the names enabled for THIS request, not from a
            # process-global view of what exists. The customer id lets the
            # customer's own declarative tools resolve alongside the built-ins.
            builtin_specs = specs_for(
                builtin_names, state.get("customer_id"),
                spec_context_for(state, builtin_names),
            )
            # A caller-defined tool shadowing a built-in name would make its
            # calls ambiguous (executed in-graph vs. by the caller) — built-in wins.
            reserved = {s["name"] for s in builtin_specs}
            shadowed = [t.get("name") for t in tools if t.get("name") in reserved]
            if shadowed:
                logger.warning("Node %s: caller tool(s) %s shadow built-in tools — dropped", agent_type, shadowed)
            tools = [t for t in tools if t.get("name") not in reserved] + builtin_specs
        tools_bound = bool(is_response_node and tools and response_format == "text" and not response_schema)
        tool_specs: list = []
        llm_betas: list = []
        if tools_bound:
            tool_specs, llm_betas = _build_tool_specs(tools, state["llm_provider"])

        tool_choice = _normalize_tool_choice(state.get("tool_choice")) if tools_bound else None

        # Extended thinking (Anthropic adaptive): response generator by
        # default — internal graph nodes (rankers, classifiers) don't need
        # reasoning latency, but an explicit thinking_level opts one in (their
        # history is replayed as condensed text, so the tool-replay constraint
        # below doesn't apply). Must be OFF on client-side tool-result
        # continuations: the replayed assistant tool-call turn is rebuilt from
        # persisted JSON without its thinking blocks, which the API rejects
        # when thinking is on. (In-graph TOOL_EXECUTOR loops keep AIMessages —
        # with thinking blocks — in state, so they're unaffected.)
        # Forced-tool_choice and model-support gates live in
        # _build_llm_and_structured / get_llm.
        if is_response_node:
            allow_thinking = not state.get("query_tool_results")
        else:
            allow_thinking = thinking_level in ("low", "medium", "high")

        # Durable /runs path: the LLM call runs as a memoized DBOS step so a
        # crash/redeploy replays the saved response instead of re-billing the
        # vendor (exactly-once). Build+invoke happen inside the step there, with
        # credentials resolved from DynamoDB so no secret is persisted. The
        # stateless /retrieve path builds the model inline and invokes it directly
        # (request-provided credentials, no DBOS involvement).
        use_durable = _dbos_active()
        llm = None
        structured_llm = None
        if not use_durable:
            llm, structured_llm = _build_llm_and_structured(
                state["llm_provider"], credentials_for(state), effective_model,
                state.get("llm_max_tokens", 4096), llm_betas, tools_bound, tool_specs,
                tool_choice, response_schema, allow_thinking=allow_thinking,
                thinking_level=thinking_level,
            )

        provider = state["llm_provider"]
        request_source = state.get("request_source") or "conversation"
        # Cache stable prefixes (system prompt + conversation history) on the response
        # generator. Anthropic requires explicit cache_control blocks; OpenAI caches
        # automatically for prefixes >=1024 tokens.
        cache_anthropic = (provider == "anthropic")

        messages: list[Any] = [_make_system(system_prompt, cache_anthropic)]

        rendered_input = _render_template(input_template, state)

        # Uploaded documents first (plans 4.1/4.2): a native PDF takes its
        # bytes out of the request's attachment budget, so the images get
        # what is left. Response generators only, like images.
        doc_budget = documents.budget_for(provider, len(state.get("query_images") or []))
        current_doc_blocks: list = []
        if is_response_node and documents.pdf_refs(state.get("query_files")):
            current_doc_blocks = await documents.current_turn_blocks(
                state.get("query_files"), provider, effective_model, doc_budget,
            )
            if cache_anthropic and current_doc_blocks:
                documents.mark_cache_breakpoint(current_doc_blocks)

        # Only the response generator sees images — retrieval/ranking/classification
        # nodes stay text-only (they don't need pixels, and it keeps them cheap).
        query_image_blocks: list = []
        image_plan = plan_request_images(
            state, provider, with_history=include_history and is_response_node,
            reserved_bytes=doc_budget.reserved_b64,
        )
        image_limits = image_plan.limits
        if is_response_node:
            query_image_blocks = await _image_blocks(state.get("query_images", []), strict=True, limits=image_limits)
        current_content = _user_content(rendered_input, query_image_blocks)
        if current_doc_blocks:
            # Documents before the question (long-document guidance of every
            # vendor); the cache breakpoint on the last one then covers them.
            text_and_images = current_content if isinstance(current_content, list) else \
                [{"type": "text", "text": current_content}]
            current_content = [*current_doc_blocks, *text_and_images]

        # Tool results for the current turn — must directly follow the assistant
        # message whose tool_calls they answer (the last history turn).
        current_tool_messages = (
            await _tool_messages(state.get("query_tool_results"), provider, image_limits) if is_response_node else []
        )
        # A tool-continuation request may carry no new prompt text; don't send an
        # empty user message in that case.
        has_current_text = bool(rendered_input.strip()) or bool(query_image_blocks)

        def _append_current_turn():
            messages.extend(current_tool_messages)
            if has_current_text or not current_tool_messages:
                messages.append(HumanMessage(content=current_content))

        if include_history:
            history = state.get("conversation_history", [])
            turns = history[:-1] if history else []

            if not turns:
                _append_current_turn()
            elif is_response_node:
                # For response generation, pass as actual chat turns
                last_idx = len(turns) - 1
                for i, turn in enumerate(turns):
                    role = turn.get("role", "user")
                    content = _with_file_context(turn.get("content", ""), turn, omit_documents=(role == "user"))
                    is_last = (i == last_idx)
                    cache_this = cache_anthropic and is_last
                    if role == "user":
                        # Replayed tool results precede the turn's own text
                        messages.extend(await _tool_messages(turn.get("tool_results"), provider, image_limits))
                        turn_blocks = await _image_blocks(
                            turn.get("images", []), strict=False, limits=image_limits, omitted=image_plan.omitted,
                        )
                        # Earlier turns' documents: their text or a stub,
                        # never the native file again (plan 4.2).
                        turn_blocks += await documents.history_turn_blocks(
                            turn.get("files"), provider, doc_budget,
                        )
                        if content or turn_blocks:
                            messages.append(_make_human(_user_content(content, turn_blocks), cache_this))
                    else:
                        turn_tool_calls = turn.get("tool_calls") or []
                        if turn_tool_calls:
                            messages.append(_history_ai_message(content, turn_tool_calls, cache_this))
                        else:
                            messages.append(_make_ai(content, cache_this))
                _append_current_turn()
            else:
                # For extraction/classification, Anthropic expects context in XML tags
                history_text = "\n".join(
                    f"{t.get('role', 'user').capitalize()}: {_with_file_context(t.get('content', ''), t)}"
                    for t in turns
                )
                combined = f"<conversation_context>\n{history_text}\n</conversation_context>\n\n{rendered_input}"
                messages.append(HumanMessage(content=combined))
        else:
            _append_current_turn()

        # In-graph agent loop (TOOL_EXECUTOR): replay this request's built-in
        # tool exchanges after the current user turn, so on re-entry the model
        # sees its own tool calls answered and produces the final response.
        # Long loops are compacted first: older rounds fold into an LLM-written
        # summary (see _compact_loop_messages) so the turn never outgrows the
        # context window.
        compaction_scratch: dict = {}
        compaction_usage: dict | None = None
        if is_response_node:
            loop_msgs = state.get("loop_messages") or []
            if loop_msgs:
                replay_msgs, compaction_scratch, compaction_usage = (
                    await _compact_loop_messages(state, config, loop_msgs, use_durable)
                )
            else:
                replay_msgs = []
            for lm in replay_msgs:
                if lm.get("role") == "assistant":
                    messages.append(
                        _history_ai_message(lm.get("content", ""), lm.get("tool_calls") or [], False)
                    )
                else:
                    messages.append(
                        ToolMessage(content=lm.get("content", ""), tool_call_id=lm.get("tool_call_id", ""))
                    )

        logger.info(
            "Node %s: calling LLM, format=%s model=%s caching=%s query_images=%d",
            agent_type, response_format, effective_model, cache_anthropic, len(query_image_blocks),
        )
        if LOG_USER_CONTENT:
            for idx, m in enumerate(messages):
                logger.info("Node %s - Message %d [%s]:\n%s\n---", agent_type, idx, type(m).__name__, _content_summary(m.content))

        parsed = None
        parsing_error = None
        llm_start = time.perf_counter()
        try:
            if use_durable:
                out = await _durable_llm_invoke(
                    state["llm_provider"], state["customer_id"], effective_model,
                    state.get("llm_max_tokens", 4096), llm_betas, tools_bound, tool_specs,
                    tool_choice, response_schema, messages,
                    allow_thinking=allow_thinking, thinking_level=thinking_level,
                )
                response = out["response"]
                parsed = out["parsed"]
                parsing_error = out["parsing_error"]
            else:
                response, parsed, parsing_error = await _invoke_llm(llm, structured_llm, messages)
            if response_schema:
                logger.info("Node %s - Received structured response: parsed=%s error=%s", agent_type, parsed is not None, parsing_error)
            elif LOG_USER_CONTENT:
                logger.info("Node %s - Received Response:\n%s\n---", agent_type, response.content)
            else:
                logger.info("Node %s - Received response", agent_type)
        except Exception:
            count("llm_request_total", status="error", vendor=provider, model=effective_model,
                  source=request_source, operation=agent_type.lower())
            raise
        count("llm_request_total", status="ok", vendor=provider, model=effective_model,
              source=request_source, operation=agent_type.lower())
        observe("llm_request_duration_seconds", time.perf_counter() - llm_start, vendor=provider)

        meta = getattr(response, "usage_metadata", None) or {}
        details = meta.get("input_token_details") or {}
        output_details = meta.get("output_token_details") or {}
        usage = {
            "input_tokens": meta.get("input_tokens", 0),
            "output_tokens": meta.get("output_tokens", 0),
            "total_tokens": meta.get("total_tokens", 0),
            "cache_read_tokens": details.get("cache_read", 0),
            "cache_creation_tokens": details.get("cache_creation", 0),
            # Reasoning/thinking tokens — a subset of output_tokens (billed at
            # the output rate), reported separately for spend granularity.
            "reasoning_tokens": output_details.get("reasoning", 0),
        }
        if compaction_usage:
            # The compaction summarization call's spend belongs to this node's
            # turn — fold it in so the run's usage accounting stays complete.
            usage = {k: usage.get(k, 0) + compaction_usage.get(k, 0) for k in usage}
        # vendor+model token totals back the cost dashboards until exact
        # costUsd is emitted from the Kotlin proxy (Micrometer pass).
        if usage["input_tokens"]:
            count("llm_tokens_total", usage["input_tokens"], vendor=provider, model=effective_model, direction="input")
        if usage["output_tokens"]:
            count("llm_tokens_total", usage["output_tokens"], vendor=provider, model=effective_model, direction="output")
        if usage["cache_read_tokens"]:
            count("llm_tokens_total", usage["cache_read_tokens"], vendor=provider, model=effective_model, direction="cache_read")
        if usage["cache_creation_tokens"]:
            count("llm_tokens_total", usage["cache_creation_tokens"], vendor=provider, model=effective_model, direction="cache_creation")
        if usage["reasoning_tokens"]:
            count("llm_tokens_total", usage["reasoning_tokens"], vendor=provider, model=effective_model, direction="reasoning")
        if usage["cache_read_tokens"] or usage["cache_creation_tokens"]:
            logger.info(
                "Node %s: cache stats — read=%d creation=%d (provider=%s)",
                agent_type, usage["cache_read_tokens"], usage["cache_creation_tokens"], provider,
            )

        def _get_text(content) -> str:
            if isinstance(content, str):
                return content
            elif isinstance(content, list):
                return "".join(b.get("text", "") if isinstance(b, dict) else str(b) for b in content)
            return str(content)

        if response_format == "json":
            try:
                content = _get_text(response.content).strip()
                if content.startswith("```"):
                    content = re.sub(r"^```[a-z]*\n?", "", content)
                    content = re.sub(r"\n?```$", "", content).strip()
                parsed = json.loads(content)
                result = _merge_outputs([
                    _route_output(state_key, parsed.get(llm_key))
                    for llm_key, state_key in json_output_mapping.items()
                ])
                result["usage"] = usage
                result.update(_trace_entry(agent_type, rendered_input, content))
                return result
            except json.JSONDecodeError:
                logger.error("Node %s: expected JSON, got: %s", agent_type, redact(_get_text(response.content), 200))
                return {"usage": usage, **_trace_entry(agent_type, rendered_input, _get_text(response.content))}

        if response_format == "json_indices":
            source = state.get(json_indices_source_key, [])
            try:
                content = _get_text(response.content).strip()
                if content.startswith("```"):
                    content = re.sub(r"^```[a-z]*\n?", "", content)
                    content = re.sub(r"\n?```$", "", content).strip()
                indices = json.loads(content)
                reordered = [source[i] for i in indices if i < len(source)]
                return {**_route_output(output_key, reordered), "usage": usage,
                        **_trace_entry(agent_type, rendered_input, content)}
            except (json.JSONDecodeError, TypeError, ValueError):
                logger.error("Node %s: expected index array, got: %s — using original order", agent_type, redact(_get_text(response.content), 200))
                return {**_route_output(output_key, source), "usage": usage,
                        **_trace_entry(agent_type, rendered_input, _get_text(response.content))}

        # response_schema set == structured output was requested (structured_llm is
        # built inline on /retrieve, but not on the durable path where the step
        # owns the model — so gate on the schema, which is truthy on both paths).
        if response_schema:
            if parsed is not None:
                return {**_route_output(output_key, json.dumps(parsed)), "usage": usage,
                        **_trace_entry(agent_type, rendered_input, json.dumps(parsed))}
            # Constrained decoding makes this near-unreachable; degrade to the
            # raw text so the caller's own parse (and failover) can decide.
            logger.error(
                "Node %s: structured output parse failed (%s) — returning raw text",
                agent_type, parsing_error,
            )
            return {**_route_output(output_key, _get_text(response.content)), "usage": usage,
                    **_trace_entry(agent_type, rendered_input, _get_text(response.content))}

        # response_format == "text"
        result = {**_route_output(output_key, _get_text(response.content)), "usage": usage,
                  **_trace_entry(agent_type, rendered_input, _get_text(response.content))}
        if compaction_scratch:
            # Pin the fold (summary + high-water mark) so later iterations
            # reuse it instead of re-summarizing every round.
            result["scratch"] = {**result.get("scratch", {}), **compaction_scratch}
        if tools_bound:
            # Reset every round: a stop reason describes only the latest one.
            result["stop_reason"] = None
            raw_tool_calls = getattr(response, "tool_calls", None) or []
            invalid_tool_calls = getattr(response, "invalid_tool_calls", None) or []
            cut_off = cut_off_reason(response)
            if cut_off or invalid_tool_calls:
                # Plan 1.8: a call cut off at the output limit parses as VALID
                # (parse_partial_json), so never trust it. Built-in calls stay,
                # marked truncated, so the executor answers each with a
                # NOT-executed result (keeping call/result pairing valid for
                # every vendor); caller-defined calls are dropped so a
                # truncated or malformed call never reaches the API caller.
                builtin_names = set(state.get("builtin_tools") or [])
                kept: list[dict] = []
                for c in raw_tool_calls:
                    name = c.get("name", "")
                    if cut_off:
                        if name in builtin_names:
                            kept.append({"id": c.get("id", ""), "name": name, "args": {},
                                         "truncated": True, "truncation_reason": cut_off})
                        else:
                            record_truncated(name, cut_off)
                    elif name in builtin_names:
                        kept.append({"id": c.get("id", ""), "name": name, "args": c.get("args") or {}})
                    else:
                        record_truncated(name, "invalid_tool_call")
                for c in invalid_tool_calls:
                    name = c.get("name") or ""
                    reason = cut_off or "invalid_tool_call"
                    if name in builtin_names:
                        kept.append({"id": c.get("id") or f"invalid_{len(kept)}", "name": name,
                                     "args": {}, "truncated": True, "truncation_reason": reason})
                    else:
                        record_truncated(name or "unknown", reason)
                for c in kept:
                    if c.get("truncated"):
                        record_truncated(c["name"], c["truncation_reason"])
                result["stop_reason"] = cut_off or "invalid_tool_call"
                if kept:
                    result["tool_calls"] = kept
                logger.warning(
                    "Node %s: response %s — %d call(s) kept for refusal, caller calls dropped",
                    agent_type, result["stop_reason"], sum(1 for c in kept if c.get("truncated")),
                )
            elif raw_tool_calls:
                result["tool_calls"] = [
                    {"id": c.get("id", ""), "name": c.get("name", ""), "args": c.get("args") or {}}
                    for c in raw_tool_calls
                ]
                logger.info(
                    "Node %s: model requested %d tool call(s): %s",
                    agent_type, len(raw_tool_calls), [c.get("name") for c in raw_tool_calls],
                )
        return result

    node.__name__ = f"llm_node_{agent_type.lower()}"
    return node
