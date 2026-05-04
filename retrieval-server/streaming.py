import json
import logging
from typing import Any, AsyncIterator, Optional

from graph.state import RetrievalState

logger = logging.getLogger(__name__)

_NODE_START_MESSAGES: dict[str, str] = {
    "QUERY_ANALYZER":    "Analyzing your query...",
    "QUERY_REWRITER":    "Rewriting query for better search...",
    "RETRIEVAL":         "Searching knowledge base...",
    "RESULT_RANKER":     "Ranking results...",
    "RESPONSE_GENERATOR": "Generating response...",
    "RESPONSE_GENERATOR_WITH_REFLECTION": "Generating response...",
}


def _format_node_output(node_type: str, output: dict) -> str | None:
    key = node_type.upper()
    if key == "QUERY_ANALYZER":
        intent = output.get("query_intent", "")
        needs_rewrite = output.get("needs_rewrite")
        if intent:
            return f"Intent: {intent} (needs rewrite: {'yes' if needs_rewrite else 'no'})"
    elif key == "QUERY_REWRITER":
        rewritten = output.get("rewritten_query", "")
        if rewritten:
            return f"Rewritten: {rewritten}"
    elif key == "RETRIEVAL":
        results = output.get("retrieval_results", [])
        return f"Found {len(results)} relevant document(s)"
    elif key == "RESULT_RANKER":
        ranked = output.get("ranked_results", [])
        return f"Ranked to {len(ranked)} most relevant result(s)"
    return None


async def stream_response(
    state: RetrievalState,
    graph: Any = None,
    node_type_map: Optional[dict[str, str]] = None,
    streaming_nodes: Optional[set[str]] = None,
    recursion_limit: int = 25,
) -> AsyncIterator[str]:
    """
    Stream SSE events from a graph execution.

    Args:
        state:           Initial RetrievalState.
        graph:           Compiled LangGraph to run.
        node_type_map:   Maps nodeId -> nodeType.
        streaming_nodes: Set of nodeIds whose LLM token output should be streamed
                         as content chunks. Agents with is_streaming=true in DDB config.
    """
    if graph is None:
        raise ValueError("stream_response requires a compiled graph — no fallback available")

    node_type_map = node_type_map or {}
    streaming_nodes = streaming_nodes or set()

    logger.info(
        "Stream: starting astream_events for customer=%s provider=%s streaming_nodes=%s",
        state["customer_id"],
        state["llm_provider"],
        streaming_nodes,
    )
    token_count = 0
    event_count = 0
    usage = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
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

            if event_type == "on_chain_start" and node:
                logger.info("Stream: node START → %s (type=%s)", node, node_type)
                msg = _NODE_START_MESSAGES.get(node_type.upper() if node_type else "")
                if msg:
                    yield f"data: {json.dumps({'thinking': msg})}\n\n"

            elif event_type == "on_chain_end" and node:
                logger.info("Stream: node END   → %s (type=%s)", node, node_type)
                output = event.get("data", {}).get("output", {})
                if isinstance(output, dict):
                    msg = _format_node_output(node_type, output)
                    if msg:
                        yield f"data: {json.dumps({'thinking': msg})}\n\n"

            if event_type == "on_chat_model_start":
                logger.info("Stream: LLM call started in node=%s", node)
            elif event_type == "on_chat_model_end":
                output = event["data"].get("output")
                meta = getattr(output, "usage_metadata", None) or {}
                usage["input_tokens"] += meta.get("input_tokens", 0)
                usage["output_tokens"] += meta.get("output_tokens", 0)
                usage["total_tokens"] += meta.get("total_tokens", 0)
                logger.info(
                    "Stream: LLM call ended node=%s — chunk_usage=%s running_total=%s",
                    node, meta, usage,
                )

            if event_type == "on_chat_model_stream" and node in streaming_nodes:
                chunk = event["data"].get("chunk")
                if chunk and chunk.content:
                    token_count += 1
                    yield f"data: {json.dumps({'content': chunk.content})}\n\n"

        logger.info(
            "Stream: completed — %d events processed, %d tokens emitted",
            event_count, token_count,
        )
        if token_count == 0:
            logger.warning("Stream: ZERO tokens emitted — streaming node may have failed or produced no output")
        logger.info(
            "Stream: total usage — input_tokens=%d output_tokens=%d total_tokens=%d",
            usage["input_tokens"], usage["output_tokens"], usage["total_tokens"],
        )
        yield f"data: {json.dumps({'usage': usage})}\n\n"
    except Exception as e:
        logger.error("Stream: unhandled exception — %s", e, exc_info=True)
        yield f"data: {json.dumps({'error': str(e)})}\n\n"
    finally:
        yield "data: [DONE]\n\n"
