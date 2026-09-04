import json
import logging
import time
from typing import Any, AsyncIterator, Optional

from graph.state import RetrievalState

logger = logging.getLogger(__name__)

# Runtime primitive of a node type — drives the thinking panel's icon/verbs.
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
) -> AsyncIterator[str]:
    """
    Stream SSE events from a graph execution.

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
    """
    if graph is None:
        raise ValueError("stream_response requires a compiled graph — no fallback available")

    node_type_map = node_type_map or {}
    node_name_map = node_name_map or {}
    streaming_nodes = streaming_nodes or set()
    builtin_tool_names = builtin_tool_names or set()

    logger.info(
        "Stream: starting astream_events for customer=%s provider=%s streaming_nodes=%s",
        state["customer_id"],
        state["llm_provider"],
        streaming_nodes,
    )
    token_count = 0
    event_count = 0
    usage = {
        "input_tokens": 0,
        "output_tokens": 0,
        "total_tokens": 0,
        "cache_read_tokens": 0,
        "cache_creation_tokens": 0,
    }
    try:
        async for event in graph.astream_events(state, config={"recursion_limit": recursion_limit}, version="v2"):
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
                yield f"data: {json.dumps({'thinking_step': step})}\n\n"

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
                    yield f"data: {json.dumps({'thinking_step': step})}\n\n"
                    # Web sources go to the caller so [n] citation markers in the
                    # generated text can be rendered as links. Emitted as soon as
                    # the search node completes — before generation streams.
                    # Artifacts produced by built-in tools (e.g. generated
                    # PDFs) go to the caller for persistence + download links.
                    if node_type and node_type.upper() == "TOOL_EXECUTOR":
                        artifacts = output.get("generated_artifacts", [])
                        if artifacts:
                            yield f"data: {json.dumps({'generated_artifacts': artifacts})}\n\n"
                    if node_type and node_type.upper() == "WEB_SEARCH":
                        sources = [
                            {"index": i, "title": r.get("title", ""), "url": r.get("url", "")}
                            for i, r in enumerate(output.get("web_search_results", []), 1)
                        ]
                        if sources:
                            yield f"data: {json.dumps({'web_sources': sources})}\n\n"
                    # Structured output: the guaranteed-JSON response arrives as
                    # one content chunk when the generator node completes.
                    if structured_output and node in streaming_nodes:
                        content = output.get("generated_response")
                        if content:
                            if token_count == 0 and request_start is not None:
                                thinking_duration_ms = int((time.monotonic() - request_start) * 1000)
                                yield f"data: {json.dumps({'thinking_duration_ms': thinking_duration_ms})}\n\n"
                            token_count += 1
                            yield f"data: {json.dumps({'content': content})}\n\n"

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
                        yield f"data: {json.dumps({'tool_calls': tool_calls})}\n\n"
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
                        yield f"data: {json.dumps({'thinking_duration_ms': thinking_duration_ms})}\n\n"
                    token_count += 1
                    yield f"data: {json.dumps({'content': chunk.content})}\n\n"

        logger.info(
            "Stream: completed — %d events processed, %d tokens emitted",
            event_count, token_count,
        )
        if token_count == 0:
            logger.warning("Stream: ZERO tokens emitted — streaming node may have failed or produced no output")
        logger.info(
            "Stream: total usage — input_tokens=%d output_tokens=%d total_tokens=%d cache_read=%d cache_creation=%d",
            usage["input_tokens"], usage["output_tokens"], usage["total_tokens"],
            usage["cache_read_tokens"], usage["cache_creation_tokens"],
        )
        yield f"data: {json.dumps({'usage': usage})}\n\n"
    except Exception as e:
        logger.error("Stream: unhandled exception — %s", e, exc_info=True)
        yield f"data: {json.dumps({'error': str(e)})}\n\n"
    finally:
        yield "data: [DONE]\n\n"
