import asyncio
import contextlib
import json
import logging
import time
from typing import Any, AsyncIterator, Optional

from encoding_library.observability import count
from graph.attachments import DocumentError
from graph.image_normalize import ImageNormalizationError
from graph.state import RetrievalState

from graph.display_args import display_args
from graph.truncation import stop_reason_of, truncation_reason

logger = logging.getLogger(__name__)

# /retrieve keepalive (plan 1.7): well under the proxy's 300 s socket timeout.
KEEPALIVE_SECONDS = 15
KEEPALIVE_FRAME = 'data: {"keepalive": true}\n\n'

# Runtime primitive of a node type — drives the thinking panel's icon/verbs.
# (substring set, error_type, user-facing label) — checked in order, first
# match wins. Substrings are matched against the lowercased exception
# type+message, which is vendor-agnostic: litellm, langchain and the native
# SDKs all put these markers somewhere in the exception.
_LLM_ERROR_KINDS = [
    (("ratelimit", "rate limit", "resource_exhausted", "too many requests", "429",
      "quota", "insufficient balance", "exceeded_current_quota"),
     "rate_limit", "Rate limit or quota exceeded"),
    (("authentication", "unauthorized", "invalid api key", "api key not valid",
      "invalid_api_key", "401", "permission denied", "403"),
     "auth", "API key rejected by the provider"),
    (("context length", "context_length", "contextwindow", "maximum context",
      "prompt is too long", "input is too long"),
     "context_length", "Input exceeds the model's context window"),
    (("not found", "does not exist", "model_not_found", "404"),
     "model_not_found", "Model not found or unavailable"),
]


def _extract_provider_detail(raw: str) -> str:
    """Pull the human sentence out of a nested provider error blob."""
    import re

    # Providers nest JSON-in-string; unescape the common wrappers first
    flat = raw.replace("\\n", " ").replace('\\"', '"')
    detail = None
    for pattern in (r'"message"\s*:\s*"([^"{}]{10,400})"', r"'message'\s*:\s*'([^'{}]{10,400})'"):
        m = re.search(pattern, flat)
        if m:
            detail = m.group(1)
            break
    if detail is None:
        # No parsable message field — take the prose before any JSON payload
        detail = flat.split("{", 1)[0]
    # Drop "libname.SomeError: SomeError: VendorException - " chains and
    # leftover escape debris
    detail = re.sub(r"^(?:[\w.]*(?:Error|Exception)\b[\s:—-]*)+", "", detail)
    detail = detail.replace("\\", " ")
    return " ".join(detail.split())[:300]


def user_facing_llm_error(e: Exception, provider: str) -> tuple[str, str]:
    """Classify an LLM-call failure into (error_type, concise user message).

    Vendor-agnostic by design: works off exception type/message markers, not
    per-vendor exception classes, so new BYOK providers are covered for free.
    """
    if isinstance(e, (ImageNormalizationError, DocumentError)):
        # Our own attachment check, not a vendor failure: the message is already
        # a user-facing sentence (unsupported format, too large, unreadable,
        # a password-protected PDF).
        return "attachment_error", str(e)
    raw = f"{type(e).__name__}: {e}"
    low = raw.lower()
    kind, label = "provider_error", "The provider returned an error"
    for needles, k, l in _LLM_ERROR_KINDS:
        if any(n in low for n in needles):
            kind, label = k, l
            break
    detail = _extract_provider_detail(str(e))
    message = f"{label} ({provider}): {detail}" if detail else f"{label} ({provider})"
    return kind, message


def _kind_of(node_type: str) -> str:
    key = (node_type or "").upper()
    if key == "RETRIEVAL":
        return "RETRIEVAL"
    if key == "WEB_SEARCH":
        return "WEB_SEARCH"
    if key == "MEMORY":
        return "MEMORY"
    if key == "RESPONSE_GENERATOR_WITH_REFLECTION":
        return "REFLECTION"
    if key == "TOOL_EXECUTOR":
        return "TOOL"
    return "LLM"


def _stop_reason_of(output) -> str:
    """The vendor's raw finish reason for one LLM call, lowercased, or "".

    stop_reason on Anthropic, finish_reason on OpenAI/Gemini — read both so this
    is vendor-agnostic — and, for the OpenAI Responses API (gpt-5), which sets
    neither, the reason of an 'incomplete' status (graph/truncation.py).
    Surfaced verbatim to the caller (a refusal, a length cap, a normal end)
    rather than translated here: the client owns how each reason is worded and
    how prominently it's shown. A refusal returns empty content and no
    exception, so without streaming this back the turn would look like a silent
    blank failure."""
    return stop_reason_of(output)


def _doc_title(result: dict) -> str:
    entity = result.get("entity", {}) or {}
    return (entity.get("title") or entity.get("subject") or entity.get("note_value") or "")[:120]


# 3.7: tools whose arguments carry a whole document while the model writes it.
PROGRESS_TOOLS = frozenset({"generate_pdf", "revise_pdf", "fs_write"})
PROGRESS_INTERVAL_SECONDS = 5.0


class _ToolArgProgress:
    """Counts streamed tool-call argument characters per call index and says
    when a progress event is due ({"tool", "chars"}), at most every
    PROGRESS_INTERVAL_SECONDS, only for PROGRESS_TOOLS."""

    def __init__(self, clock=time.monotonic):
        self._clock = clock
        self._names: dict = {}
        self._chars: dict = {}
        self._last = 0.0

    def update(self, chunk) -> dict | None:
        chunks = getattr(chunk, "tool_call_chunks", None) or []
        if not chunks:
            return None
        for c in chunks:
            index = c.get("index") if isinstance(c, dict) else getattr(c, "index", None)
            name = c.get("name") if isinstance(c, dict) else getattr(c, "name", None)
            args = c.get("args") if isinstance(c, dict) else getattr(c, "args", None)
            key = index if index is not None else 0
            if name:
                self._names[key] = name
            if args:
                self._chars[key] = self._chars.get(key, 0) + len(args)
        due = [k for k, n in self._names.items() if n in PROGRESS_TOOLS and self._chars.get(k)]
        now = self._clock()
        if not due or now - self._last < PROGRESS_INTERVAL_SECONDS:
            return None
        self._last = now
        key = due[-1]
        return {"tool": self._names[key], "chars": self._chars[key]}


def _fmt_tool_call(call: dict) -> str:
    """Human-readable call signature for the thinking panel, e.g.
    web_search(query="...", topic="news") — generic over any tool's args, not
    just web_search's, so a customer's own declarative tools render the same
    way. Short args are shown in full — the query text is often the one thing
    worth reading a tool call for — while long ones (a whole document passed
    to generate_pdf) are shortened by display_args."""
    name = call.get("name", "")
    args = display_args(call.get("args"))
    if not args:
        return name
    parts = []
    for k, v in args.items():
        if isinstance(v, str):
            parts.append(f'{k}="{v}"')
        else:
            parts.append(f"{k}={json.dumps(v, default=str)}")
    return f"{name}({', '.join(parts)})"


_MAX_ITEMS = 5


def _step_done_payload(node_type: str, output: dict) -> dict:
    """detail / items / prompt / response of a completed node, from its update."""
    payload: dict = {}
    kind = _kind_of(node_type)

    trace = output.get("trace") or []
    if trace:
        entry = trace[-1]
        payload["prompt"] = entry.get("prompt", "")
        payload["response"] = entry.get("response", "")

    if kind == "RETRIEVAL":
        results = output.get("retrieval_results", [])
        payload["detail"] = f"Found {len(results)} relevant document(s)"
        payload["items"] = [t for t in (_doc_title(r) for r in results[:_MAX_ITEMS]) if t]
    elif kind == "WEB_SEARCH":
        results = output.get("web_search_results", [])
        payload["detail"] = f"Found {len(results)} web result(s)"
        payload["items"] = [r.get("title", "")[:120] for r in results[:_MAX_ITEMS]]
        # Untruncated {index, title, url} triples — items above stays
        # title-only/capped for older clients. index matches the numbering the
        # separate web_sources event uses below, so a client can correlate a
        # source shown here with the [n] marker it becomes in the final answer.
        payload["sources"] = [
            {"index": i, "title": r.get("title", ""), "url": r.get("url", "")}
            for i, r in enumerate(results, 1)
        ]
    elif kind == "TOOL":
        artifacts = output.get("generated_artifacts", [])
        sources = output.get("tool_sources", [])
        # Per-call breakdown (name, args, its own sources/artifacts/error) — see
        # tool_executor.py. Falls back to [] for any trace predating this field.
        calls = (trace[-1].get("calls") if trace else None) or []
        payload["detail"] = f"Executed {len(calls)} tool(s)"
        payload["calls"] = calls
        # The agent's current todo checklist, when this round updated it
        # (write_todos). Rides the thinking_step so the client renders it live
        # and the proxy persists it with the turn's thinking content.
        todos = trace[-1].get("todos") if trace else None
        if todos is not None:
            payload["todos"] = todos
        # Back-compat flat view: artifact filenames + newest cited titles, capped.
        items = [a.get("filename", "")[:120] for a in artifacts]
        items += [s.get("title", "")[:120] for s in sources[-_MAX_ITEMS:] if s.get("title")]
        payload["items"] = items[:_MAX_ITEMS]
    elif kind == "MEMORY":
        block = output.get("memories_block") or ""
        memories = [line[2:] for line in block.splitlines() if line.startswith("- ")]
        stats = (output.get("scratch") or {}).get("memory_stats")
        if stats is not None:
            core_count = stats.get("core", 0)
            recalled_count = stats.get("recalled", 0)
            parts = []
            if core_count:
                parts.append(f"Applied {core_count} core memori(es)")
            if recalled_count:
                parts.append(f"recalled {recalled_count} related to this message")
            payload["detail"] = "; ".join(parts) if parts else "No stored memories to apply"
            # The block renders core lines first, then recalled; recalled are
            # the per-message news, so they lead the (capped) item list.
            recalled_items = memories[core_count:]
            payload["items"] = [m[:120] for m in (recalled_items + memories[:core_count])[:_MAX_ITEMS]]
        else:
            payload["detail"] = (
                f"Applied {len(memories)} learned memori(es)" if memories else "No stored memories to apply"
            )
            payload["items"] = [m[:120] for m in memories[:_MAX_ITEMS]]
    else:
        # LLM-backed nodes: summarize the well-known output fields.
        intent = output.get("query_intent")
        rewritten = output.get("rewritten_query")
        ranked = output.get("ranked_results")
        if intent:
            needs = "yes" if output.get("needs_rewrite") else "no"
            payload["detail"] = f"Intent: {intent} (needs rewrite: {needs})"
        elif rewritten:
            payload["detail"] = f"Rewrote the query to: {rewritten}"
        elif isinstance(ranked, list):
            payload["detail"] = f"Kept the {len(ranked)} most relevant result(s)"
        elif output.get("tool_calls"):
            # A tool-calling turn. The model may still have written text before
            # deciding to call tools (its reasoning for searching again, e.g.)
            # — surface it instead of silently dropping it in favor of the
            # generic "Calling tools" label.
            reasoning = (output.get("generated_response") or "").strip()
            if reasoning:
                payload["reasoning"] = reasoning
            calls = output["tool_calls"]
            labels = [_fmt_tool_call(c) for c in calls if c.get("name")]
            payload["detail"] = ("Calling tools: " + ", ".join(labels)) if labels else "Calling tools"
            # Structured form of the same calls, for clients that want to render
            # name/args separately rather than parsing the label string.
            payload["tool_calls"] = [
                {"name": c.get("name", ""), "args": display_args(c.get("args"))} for c in calls
            ]
        elif output.get("generated_response"):
            payload["detail"] = "Response generated"
    return payload


def _start_label(kind: str, name: str) -> str:
    return {
        "RETRIEVAL": f"{name}: searching the knowledge base…",
        "WEB_SEARCH": f"{name}: searching the web…",
        "MEMORY": f"{name}: loading what is known about you…",
        "REFLECTION": f"{name}: generating and reflecting…",
        "TOOL": f"{name}: running tools…",
    }.get(kind, f"{name}: thinking…")


async def stream_events_dicts(
    state: RetrievalState,
    graph: Any = None,
    node_type_map: Optional[dict[str, str]] = None,
    node_name_map: Optional[dict[str, str]] = None,
    streaming_nodes: Optional[set[str]] = None,
    recursion_limit: int = 25,
    request_start: Optional[float] = None,
    structured_output: bool = False,
    builtin_tool_names: Optional[set[str]] = None,
    thread_id: Optional[str] = None,
) -> AsyncIterator[dict]:
    """
    Run a graph and yield outbound stream events as plain dict payloads:
    {'thinking_step': …}, {'content': …}, {'content_reset': True},
    {'tool_calls': …}, {'web_sources': …}, {'generated_artifacts': …},
    {'thinking_duration_ms': …}, {'stop_reason': …}, {'usage': …}, or
    {'error': …, 'error_type': …}.

    stop_reason is the vendor's raw finish reason (end_turn / stop / max_tokens /
    refusal / content_filter / …) for the round that ends the turn — streamed
    verbatim so the client can always show why generation stopped, and so a
    refusal (empty content, no exception) isn't a silent blank.

    content_reset fires when a generation round ends in tool calls that will be
    executed in-graph: the round's streamed content was a tool-call preamble,
    and consumers accumulating content into answer text must discard it before
    the next round streams.

    Transport-agnostic — this is the single source of truth for the event
    protocol. `stream_response` wraps each dict as an SSE `data:` frame for the
    stateless /retrieve path; the durable agent_run workflow publishes each dict
    to run_events for the /runs path. The `[DONE]` sentinel is a transport
    concern and is NOT emitted here — the SSE wrapper / the run's terminal row
    signal end-of-stream.

    Args:
        state:           Initial RetrievalState.
        graph:           Compiled LangGraph to run.
        node_type_map:   Maps nodeId -> nodeType.
        streaming_nodes: Set of nodeIds whose LLM token output should be streamed
                         as content chunks. Agents with is_streaming=true in DDB config.
        request_start:   time.monotonic() taken when the HTTP request was received.
                         Used to emit thinking_duration_ms (request receipt → first
                         generated token) just before the first content chunk.
        structured_output: True when the request carries a response_schema. Token
                         deltas are then partial JSON (only valid once complete),
                         so per-token streaming is suppressed and the finished
                         JSON object is emitted as a single content chunk when
                         the generator node completes. Any synthetic schema tool
                         call is never surfaced as a tool_calls event.
        builtin_tool_names: Names of built-in (graph_tools) tools bound for this
                         request. Their calls are executed in-graph by the
                         TOOL_EXECUTOR node and must never be emitted to the
                         caller as tool_calls events.
        thread_id:       When set, passed as config.configurable.thread_id so a
                         checkpointer-bound (durable) graph persists/resumes this
                         run. The stateless /retrieve path leaves it None.
    """
    if graph is None:
        raise ValueError("stream_events_dicts requires a compiled graph — no fallback available")

    node_type_map = node_type_map or {}
    node_name_map = node_name_map or {}
    streaming_nodes = streaming_nodes or set()
    builtin_tool_names = builtin_tool_names or set()

    # `state` is the initial RetrievalState dict on a fresh run, but on a durable
    # resume it's a langgraph Command(resume=...) — guard the dict-only accesses.
    _provider = state.get("llm_provider", "") if isinstance(state, dict) else ""
    if isinstance(state, dict):
        logger.info(
            "Stream: starting astream_events for customer=%s provider=%s streaming_nodes=%s",
            state.get("customer_id"), _provider, streaming_nodes,
        )
    else:
        logger.info("Stream: resuming astream_events (Command) streaming_nodes=%s", streaming_nodes)
    token_count = 0
    _progress = _ToolArgProgress()
    event_count = 0
    usage = {
        "input_tokens": 0,
        "output_tokens": 0,
        "total_tokens": 0,
        "cache_read_tokens": 0,
        "cache_creation_tokens": 0,
        # Reasoning/thinking tokens — a subset of output_tokens (billed at the
        # output rate), reported separately for spend granularity.
        "reasoning_tokens": 0,
    }
    config: dict = {"recursion_limit": recursion_limit}
    if thread_id is not None:
        # Required by LangGraph whenever a checkpointer is attached (durable runs).
        config["configurable"] = {"thread_id": thread_id}
    try:
        async for event in graph.astream_events(state, config=config, version="v2"):
            event_type = event.get("event", "")
            node = event.get("metadata", {}).get("langgraph_node", "")
            event_count += 1

            logger.debug(
                "Stream event #%d: type=%s node=%s name=%s",
                event_count, event_type, node, event.get("name", ""),
            )

            node_type = node_type_map.get(node, node)

            # Only the node's own runnable (event name == node id) drives the
            # thinking steps — inner chains repeat the langgraph_node metadata
            # and previously caused duplicate messages.
            is_node_event = bool(node) and event.get("name") == node

            if event_type == "on_chain_start" and is_node_event:
                logger.info("Stream: node START → %s (type=%s)", node, node_type)
                kind = _kind_of(node_type)
                name = node_name_map.get(node) or node_type or node
                step = {
                    "node": node,
                    "name": name,
                    "kind": kind,
                    "status": "running",
                    "label": _start_label(kind, name),
                }
                yield {"thinking_step": step}

            elif event_type == "on_chain_end" and is_node_event:
                logger.info("Stream: node END   → %s (type=%s)", node, node_type)
                output = event.get("data", {}).get("output", {})
                if isinstance(output, dict):
                    kind = _kind_of(node_type)
                    name = node_name_map.get(node) or node_type or node
                    step = {
                        "node": node,
                        "name": name,
                        "kind": kind,
                        "status": "done",
                        **_step_done_payload(node_type, output),
                    }
                    yield {"thinking_step": step}
                    # Web sources go to the caller so [n] citation markers in the
                    # generated text can be rendered as links. Emitted as soon as
                    # the search node completes — before generation streams.
                    # Artifacts produced by built-in tools (e.g. generated
                    # PDFs) go to the caller for persistence + download links.
                    if node_type and node_type.upper() == "TOOL_EXECUTOR":
                        artifacts = output.get("generated_artifacts", [])
                        if artifacts:
                            yield {"generated_artifacts": artifacts}
                        # Citable sources any built-in tool surfaced (web_search
                        # today). Already {index, title, url} with turn-global
                        # indices — the full accumulated snapshot, so the answer's
                        # [n] markers resolve to links. Same event and shape as
                        # the legacy WEB_SEARCH node below; the caller can't tell
                        # which produced them.
                        tool_sources = output.get("tool_sources") or []
                        if tool_sources:
                            yield {"web_sources": tool_sources}
                    if node_type and node_type.upper() == "WEB_SEARCH":
                        sources = [
                            {"index": i, "title": r.get("title", ""), "url": r.get("url", "")}
                            for i, r in enumerate(output.get("web_search_results", []), 1)
                        ]
                        if sources:
                            yield {"web_sources": sources}
                    # Structured output: the guaranteed-JSON response arrives as
                    # one content chunk when the generator node completes.
                    if structured_output and node in streaming_nodes:
                        content = output.get("generated_response")
                        if content:
                            if token_count == 0 and request_start is not None:
                                thinking_duration_ms = int((time.monotonic() - request_start) * 1000)
                                yield {"thinking_duration_ms": thinking_duration_ms}
                            token_count += 1
                            yield {"content": content}

            if event_type == "on_chat_model_start":
                logger.info("Stream: LLM call started in node=%s", node)
            elif event_type == "on_chat_model_end":
                output = event["data"].get("output")
                meta = getattr(output, "usage_metadata", None) or {}
                details = meta.get("input_token_details") or {}
                output_details = meta.get("output_token_details") or {}
                usage["input_tokens"] += meta.get("input_tokens", 0)
                usage["output_tokens"] += meta.get("output_tokens", 0)
                usage["total_tokens"] += meta.get("total_tokens", 0)
                usage["cache_read_tokens"] += details.get("cache_read", 0)
                usage["cache_creation_tokens"] += details.get("cache_creation", 0)
                usage["reasoning_tokens"] += output_details.get("reasoning", 0)
                logger.info(
                    "Stream: LLM call ended node=%s — chunk_usage=%s running_total=%s",
                    node, meta, usage,
                )
                # Tool calls from the response generator go to the caller, who
                # executes them and continues the turn via tool_results. Under
                # structured output the only tool call is the schema's synthetic
                # forced tool — never surface it.
                if node in streaming_nodes and not structured_output:
                    raw_tool_calls = getattr(output, "tool_calls", None) or []
                    truncated = truncation_reason(output)
                    if truncated:
                        # Plan 1.8: a call cut off at the output limit (or
                        # malformed) is never forwarded to the caller; built-in
                        # ones are refused in-graph by the executor. Say why.
                        raw_tool_calls = [
                            c for c in raw_tool_calls if c.get("name", "") in builtin_tool_names
                        ]
                        logger.warning("Stream: node=%s response %s — caller tool calls withheld", node, truncated)
                        yield {"stop_reason": truncated}
                    # Built-in tool calls are executed in-graph by the
                    # TOOL_EXECUTOR node — never surfaced to the caller. On a
                    # mixed turn the executor drops the caller-defined calls
                    # too (see tool_executor.py), so emit nothing.
                    has_builtin = any(c.get("name", "") in builtin_tool_names for c in raw_tool_calls)
                    if raw_tool_calls and not has_builtin:
                        tool_calls = [
                            {"id": c.get("id", ""), "name": c.get("name", ""), "args": c.get("args") or {}}
                            for c in raw_tool_calls
                        ]
                        logger.info("Stream: emitting %d tool call(s): %s", len(tool_calls), [c["name"] for c in tool_calls])
                        yield {"tool_calls": tool_calls}
                    elif has_builtin:
                        logger.info(
                            "Stream: suppressing tool_calls event — built-in call(s) handled in-graph: %s",
                            [c.get("name") for c in raw_tool_calls],
                        )
                        # Any text this round streamed was a tool-call preamble
                        # ("Let me look up…"), not answer text — the graph loops
                        # through TOOL_EXECUTOR and a fresh generation round
                        # follows. Tell consumers to discard what they have
                        # accumulated so far: the proxy resets its persistence
                        # buffer and the client clears the visible text. The
                        # preamble itself is preserved in the thinking step's
                        # `reasoning` field, so nothing is lost from the panel.
                        yield {"content_reset": True}
                    if not raw_tool_calls:
                        # This round produced no tool calls, so it terminates the
                        # turn — a plain answer (end_turn/stop), a length cap
                        # (max_tokens), or a refusal/safety block (empty content).
                        # Stream the raw reason so the client can always show why
                        # generation ended, and so a refusal isn't a silent blank.
                        # In-graph tool rounds are skipped: the reason there is
                        # "tool_use", and the *next* round carries the real
                        # terminal reason.
                        stop_reason = _stop_reason_of(output)
                        if stop_reason:
                            logger.info("Stream: node=%s stop_reason=%s", node, stop_reason)
                            yield {"stop_reason": stop_reason}

            if event_type == "on_chat_model_stream" and node in streaming_nodes and not structured_output:
                chunk = event["data"].get("chunk")
                # 3.7: tool-call argument deltas send nothing to the client, so
                # writing a long document looked like a silent wait. Report the
                # argument size of document-writing tools every few seconds.
                progress = _progress.update(chunk)
                if progress is not None:
                    yield {"progress": progress}
                # With tools bound, providers stream tool-call argument deltas as
                # block lists — extract only the text so raw blocks never leak
                # into the content stream.
                if chunk and isinstance(chunk.content, list):
                    text = "".join(
                        b.get("text", "") for b in chunk.content
                        if isinstance(b, dict) and b.get("type") == "text"
                    )
                    chunk.content = text
                if chunk and chunk.content:
                    if token_count == 0 and request_start is not None:
                        # Actual response generation begins now — everything up to
                        # this point (retrieval, ranking, LLM ramp-up) was "thinking"
                        thinking_duration_ms = int((time.monotonic() - request_start) * 1000)
                        logger.info("Stream: thinking phase took %d ms", thinking_duration_ms)
                        yield {"thinking_duration_ms": thinking_duration_ms}
                    token_count += 1
                    yield {"content": chunk.content}

        logger.info(
            "Stream: completed — %d events processed, %d tokens emitted",
            event_count, token_count,
        )
        if token_count == 0:
            # Alarmed on: the user received an empty answer inside a 200 response.
            count("stream_zero_tokens_total", vendor=_provider)
            logger.warning("Stream: ZERO tokens emitted — streaming node may have failed or produced no output")
        logger.info(
            "Stream: total usage — input_tokens=%d output_tokens=%d total_tokens=%d cache_read=%d cache_creation=%d reasoning=%d",
            usage["input_tokens"], usage["output_tokens"], usage["total_tokens"],
            usage["cache_read_tokens"], usage["cache_creation_tokens"], usage["reasoning_tokens"],
        )
        yield {"usage": usage}
    except Exception as e:
        # The HTTP status is already 200 by now — this counter is the only
        # failure signal for errors surfaced mid-stream.
        count("stream_error_total", vendor=_provider)
        logger.error("Stream: unhandled exception — %s", e, exc_info=True)
        kind, message = user_facing_llm_error(e, _provider)
        yield {"error": message, "error_type": kind}


async def stream_response(
    state: RetrievalState,
    graph: Any = None,
    node_type_map: Optional[dict[str, str]] = None,
    node_name_map: Optional[dict[str, str]] = None,
    streaming_nodes: Optional[set[str]] = None,
    recursion_limit: int = 25,
    request_start: Optional[float] = None,
    structured_output: bool = False,
    builtin_tool_names: Optional[set[str]] = None,
    thread_id: Optional[str] = None,
) -> AsyncIterator[str]:
    """SSE wrapper over stream_events_dicts for the stateless /retrieve path:
    each event dict becomes a `data: {json}\\n\\n` frame, followed by the
    terminating `data: [DONE]\\n\\n`.

    Keepalive (plan 1.7): the proxy cuts a stream that is silent for 300 s,
    and nothing is emitted while the model writes a long tool argument, while
    a render waits for the heavy-job slot or while a tool runs. So after
    KEEPALIVE_SECONDS without a frame this emits {"keepalive": true}, which
    the proxy parses to nothing (unknown key) yet which resets its socket
    timer. The timer lives here, NOT in stream_events_dicts: the durable
    runs path consumes that generator too and would publish every keepalive
    as a run_events row (/runs has its own keepalive in its tail). The inner
    generator is pumped through a queue from its own task: wrapping its
    __anext__ in wait_for would cancel the generator on the first timeout."""
    queue: asyncio.Queue = asyncio.Queue(maxsize=256)

    async def produce() -> None:
        events = stream_events_dicts(
            state,
            graph=graph,
            node_type_map=node_type_map,
            node_name_map=node_name_map,
            streaming_nodes=streaming_nodes,
            recursion_limit=recursion_limit,
            request_start=request_start,
            structured_output=structured_output,
            builtin_tool_names=builtin_tool_names,
            thread_id=thread_id,
        )
        try:
            # aclosing: a cancelled stream closes the graph run now, not
            # whenever the generator happens to be garbage-collected.
            async with contextlib.aclosing(events):
                async for payload in events:
                    await queue.put(("item", payload))
            await queue.put(("end", None))
        except asyncio.CancelledError:
            raise
        except BaseException as e:  # re-raised by the consumer below
            await queue.put(("error", e))

    producer = asyncio.create_task(produce())
    try:
        while True:
            try:
                kind, value = await asyncio.wait_for(queue.get(), KEEPALIVE_SECONDS)
            except asyncio.TimeoutError:
                yield KEEPALIVE_FRAME
                continue
            if kind == "item":
                yield f"data: {json.dumps(value)}\n\n"
            elif kind == "end":
                break
            else:
                raise value
    finally:
        if not producer.done():
            producer.cancel()
        await asyncio.gather(producer, return_exceptions=True)
        yield "data: [DONE]\n\n"
