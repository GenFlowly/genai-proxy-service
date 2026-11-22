import json
import logging
import re
import time
from typing import Any, AsyncIterator, Awaitable, Callable, Optional

from dbos._error import DBOSMaxStepRetriesExceeded

from activity import ActivityRecorder
from activity.recorder import chunk_text, stop_reason_of as _stop_reason_of
from activity.schema import TURN_COMPLETED, TURN_ERROR
from encoding_library.observability import count
from graph.image_normalize import ImageNormalizationError
from graph.state import RetrievalState

logger = logging.getLogger(__name__)

# Same marker shape the client's linkifyCitations matches (Response.tsx).
_CITATION_MARKER = re.compile(r"\[(\d{1,3})\]")

# How often (at most) stream_events_dicts polls should_stop between events.
_STOP_CHECK_INTERVAL_SECONDS = 1.0


def _cited_web_sources(sources: list, answer: str) -> Optional[list]:
    """The subset of `sources` the final answer actually cites — or None when
    no trimming event should be emitted.

    Models search broadly but cite narrowly, so the mid-turn web_sources
    snapshots (every result of every search) are mostly noise by the time the
    answer exists. Consumers treat web_sources as last-write-wins (the client
    replaces its list, the proxy persists the last event), so one trimmed
    event at end of turn is all it takes to show/persist only cited entries —
    while the activity log keeps every per-call result for the panel.

    Original `index` values are preserved: the client resolves [n] markers via
    each entry's index field, never array position, so gaps are fine and the
    already-streamed answer text needs no rewriting.

    None (emit nothing, the full list stands) when: there are no sources; the
    answer carries no [n] markers at all — a model that searched but cited
    nothing keeps full provenance; the markers match no entry (stray
    numbering — a full list beats an empty one); or nothing would be trimmed.
    """
    if not sources or not answer:
        return None
    cited = {int(n) for n in _CITATION_MARKER.findall(answer)}
    if not cited:
        return None
    trimmed = [s for s in sources if s.get("index") in cited]
    if not trimmed or len(trimmed) == len(sources):
        return None
    return trimmed

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
    # OpenAI rate-limit boilerplate: account IDs and a docs link the user can't act on
    detail = re.sub(r"\s+(?:in\s+)?(?:project\s+proj_|organization\s+org-)\S+", "", detail)
    detail = re.sub(r"\s*Visit https?://\S+(?: to learn more)?\.?", "", detail)
    detail = detail.replace("\\", " ")
    return " ".join(detail.split())[:300]


def user_facing_llm_error(e: Exception, provider: str) -> tuple[str, str]:
    """Classify an LLM-call failure into (error_type, concise user message).

    Vendor-agnostic by design: works off exception type/message markers, not
    per-vendor exception classes, so new BYOK providers are covered for free.
    """
    if isinstance(e, DBOSMaxStepRetriesExceeded) and e.errors:
        # The durable LLM step gave up after retrying a transient vendor error;
        # DBOS's own message ("Step llm_invoke has exceeded…") hides it.
        e = e.errors[-1]
    if isinstance(e, ImageNormalizationError):
        # Our own attachment check, not a vendor failure: the message is already
        # a user-facing sentence (unsupported format, too large, unreadable).
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
    should_stop: Optional[Callable[[], Awaitable[bool]]] = None,
    recorder: Optional[ActivityRecorder] = None,
) -> AsyncIterator[dict]:
    """
    Run a graph and yield outbound stream events as plain dict payloads:
    {'activity': …}, {'content': …}, {'content_reset': True},
    {'tool_calls': …}, {'web_sources': …}, {'generated_artifacts': …},
    {'stop_reason': …}, {'usage': …}, or {'error': …, 'error_type': …}.

    activity events are the turn's step log for the client's thinking panel
    (see the activity package); every graph event passes through the turn's
    ActivityRecorder first.

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
        request_start:   time.monotonic() taken when the HTTP request was received;
                         the activity log's clock starts there.
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
        should_stop:     Async predicate polled between graph events (throttled);
                         True aborts the run — remaining steps (LLM rounds, web
                         searches, vector lookups) are skipped. The /retrieve
                         path passes request.is_disconnected so a user cancel
                         (the proxy drops the connection) stops billing; the
                         durable /runs path leaves it None — background runs
                         outlive their stream by design and are stopped via
                         their own cancel endpoint.
        recorder:        The turn's ActivityRecorder when the caller runs several
                         graph passes as one turn (durable human-input resumes):
                         the caller then calls finish(). When None, this call
                         owns a fresh recorder and ends the turn itself.
    """
    if graph is None:
        raise ValueError("stream_events_dicts requires a compiled graph — no fallback available")

    node_type_map = node_type_map or {}
    node_name_map = node_name_map or {}
    streaming_nodes = streaming_nodes or set()
    builtin_tool_names = builtin_tool_names or set()
    owns_recorder = recorder is None
    if owns_recorder:
        recorder = ActivityRecorder(
            node_type_map=node_type_map,
            node_name_map=node_name_map,
            streaming_nodes=streaming_nodes,
            structured_output=structured_output,
            started_at=request_start,
        )

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
    # Final-answer accumulator + last emitted web_sources snapshot, for the
    # end-of-turn cited-only trimming event (see _cited_web_sources).
    answer_parts: list[str] = []
    last_web_sources: list = []
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
        events = graph.astream_events(state, config=config, version="v2")
        last_stop_check = time.monotonic()
        async for event in events:
            # A gone client (user hit Stop → the proxy cancelled its relay and
            # dropped this connection) makes every further step unobservable
            # billed work. aclose() cancels the graph's in-flight tasks, so no
            # future step runs; the step currently executing still completes.
            if should_stop is not None and time.monotonic() - last_stop_check >= _STOP_CHECK_INTERVAL_SECONDS:
                last_stop_check = time.monotonic()
                if await should_stop():
                    count("stream_client_disconnect_total", vendor=_provider)
                    logger.info(
                        "Stream: client disconnected — aborting run after %d events, %d tokens",
                        event_count, token_count,
                    )
                    await events.aclose()
                    return
            event_type = event.get("event", "")
            node = event.get("metadata", {}).get("langgraph_node", "")
            event_count += 1

            logger.debug(
                "Stream event #%d: type=%s node=%s name=%s",
                event_count, event_type, node, event.get("name", ""),
            )
            for activity_event in recorder.observe(event):
                yield {"activity": activity_event}

            node_type = node_type_map.get(node, node)
            is_node_event = bool(node) and event.get("name") == node

            if event_type == "on_chain_start" and is_node_event:
                logger.info("Stream: node START → %s (type=%s)", node, node_type)

            elif event_type == "on_chain_end" and is_node_event:
                logger.info("Stream: node END   → %s (type=%s)", node, node_type)
                output = event.get("data", {}).get("output", {})
                if isinstance(output, dict):
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
                        # [n] markers resolve to links.
                        tool_sources = output.get("tool_sources") or []
                        if tool_sources:
                            last_web_sources = tool_sources
                            yield {"web_sources": tool_sources}
                    # Structured output: the guaranteed-JSON response arrives as
                    # one content chunk when the generator node completes.
                    if structured_output and node in streaming_nodes:
                        content = output.get("generated_response")
                        if content:
                            token_count += 1
                            answer_parts.append(content)
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
                        # preamble itself is preserved in the activity log's
                        # llm step as `reasoning`, so nothing is lost from the panel.
                        answer_parts.clear()
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
                # With tools bound, providers stream tool-call argument deltas as
                # block lists — only the text reaches the content stream.
                text = chunk_text(event["data"].get("chunk"))
                if text:
                    token_count += 1
                    answer_parts.append(text)
                    yield {"content": text}

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
        # Turn complete — replace the full web_sources snapshot with the cited
        # subset (last-write-wins downstream: live panel trims, proxy persists
        # only these). Skipped on the error path above: a partial answer keeps
        # the full list.
        answer = "".join(answer_parts)
        if last_web_sources:
            found = {s.get("index") for s in last_web_sources}
            recorder.cite(int(n) for n in _CITATION_MARKER.findall(answer) if int(n) in found)
        trimmed_sources = _cited_web_sources(last_web_sources, answer)
        if trimmed_sources is not None:
            logger.info(
                "Stream: trimming web_sources to cited entries — %d → %d",
                len(last_web_sources), len(trimmed_sources),
            )
            yield {"web_sources": trimmed_sources}
        if owns_recorder:
            for activity_event in recorder.finish(TURN_COMPLETED):
                yield {"activity": activity_event}
        yield {"usage": usage}
    except Exception as e:
        # The HTTP status is already 200 by now — this counter is the only
        # failure signal for errors surfaced mid-stream.
        count("stream_error_total", vendor=_provider)
        logger.error("Stream: unhandled exception — %s", e, exc_info=True)
        kind, message = user_facing_llm_error(e, _provider)
        if owns_recorder:
            for activity_event in recorder.finish(TURN_ERROR):
                yield {"activity": activity_event}
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
    should_stop: Optional[Callable[[], Awaitable[bool]]] = None,
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
            should_stop=should_stop,
        ):
            yield f"data: {json.dumps(payload)}\n\n"
    except GeneratorExit:
        # Client disconnected (Starlette aclose()): yielding here would raise
        # "async generator ignored GeneratorExit" and leave inner-generator
        # cleanup to GC. GeneratorExit is a BaseException, so it must be
        # caught before the broader handler below.
        raise
    except BaseException:
        yield "data: [DONE]\n\n"
        raise
    else:
        yield "data: [DONE]\n\n"
