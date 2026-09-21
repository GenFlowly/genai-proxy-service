import json
import logging
import time
from typing import Any, AsyncIterator, Optional

from encoding_library.observability import count
from graph.state import RetrievalState

logger = logging.getLogger(__name__)

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


def _doc_title(result: dict) -> str:
    entity = result.get("entity", {}) or {}
    return (entity.get("title") or entity.get("subject") or entity.get("note_value") or "")[:120]


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
    elif kind == "TOOL":
        artifacts = output.get("generated_artifacts", [])
        executed = [m for m in output.get("loop_messages", []) if m.get("role") == "tool"]
        payload["detail"] = f"Executed {len(executed)} tool(s)"
        payload["items"] = [a.get("filename", "")[:120] for a in artifacts[:_MAX_ITEMS]]
    elif kind == "MEMORY":
        block = output.get("memories_block") or ""
        memories = [line[2:] for line in block.splitlines() if line.startswith("- ")]
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
        elif output.get("generated_response") is not None:
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
    {'thinking_step': …}, {'content': …}, {'tool_calls': …}, {'web_sources': …},
    {'generated_artifacts': …}, {'thinking_duration_ms': …}, {'usage': …}, or
    {'error': …, 'error_type': …}.

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
    event_count = 0
    usage = {
        "input_tokens": 0,
        "output_tokens": 0,
        "total_tokens": 0,
        "cache_read_tokens": 0,
        "cache_creation_tokens": 0,
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
                usage["input_tokens"] += meta.get("input_tokens", 0)
                usage["output_tokens"] += meta.get("output_tokens", 0)
                usage["total_tokens"] += meta.get("total_tokens", 0)
                usage["cache_read_tokens"] += details.get("cache_read", 0)
                usage["cache_creation_tokens"] += details.get("cache_creation", 0)
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

            if event_type == "on_chat_model_stream" and node in streaming_nodes and not structured_output:
                chunk = event["data"].get("chunk")
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
            "Stream: total usage — input_tokens=%d output_tokens=%d total_tokens=%d cache_read=%d cache_creation=%d",
            usage["input_tokens"], usage["output_tokens"], usage["total_tokens"],
            usage["cache_read_tokens"], usage["cache_creation_tokens"],
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
    terminating `data: [DONE]\\n\\n`."""
    try:
        async for payload in stream_events_dicts(
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
        ):
            yield f"data: {json.dumps(payload)}\n\n"
    finally:
        yield "data: [DONE]\n\n"
