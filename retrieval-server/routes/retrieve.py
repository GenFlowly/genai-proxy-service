import json
import logging
import time

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from langgraph.graph import END, StateGraph

from graph.dynamic_graph import get_or_build_graph, _DEFAULT_MAX_ITERATIONS
from graph.graph_loader import get_default_graph_and_nodes
from graph.nodes.llm_node import make_llm_node
from graph.state import RetrievalState
from models import RetrieveRequest
from streaming import stream_response

logger = logging.getLogger(__name__)

router = APIRouter()


def _build_state(req: RetrieveRequest, node_configs: dict) -> RetrievalState:
    return RetrievalState(
        customer_id=req.customer_id,
        client=req.client,
        data_type=req.data_type,
        model_type=req.model_type,
        model_name=req.model_name,
        original_query=req.raw_data.query_data,
        query_images=[img.model_dump() for img in req.raw_data.images],
        tools=[t.model_dump() for t in req.tools],
        tool_choice=req.tool_choice,
        query_tool_results=[r.model_dump() for r in req.tool_results],
        tool_calls=None,
        rewritten_query=None,
        needs_rewrite=False,
        query_intent=None,
        top_n=req.raw_data.top_n,
        search_params=req.raw_data.search_params,
        similarity_threshold=req.raw_data.similarity_threshold,
        llm_credentials=req.llm_credentials,
        llm_provider=req.llm_provider,
        llm_model=req.llm_model,
        llm_max_tokens=req.llm_max_tokens,
        conversation_history=[m.model_dump() for m in req.conversation_history],
        node_configs=node_configs,
        request_system_prompt=req.system_prompt,
        retrieval_results=[],
        ranked_results=[],
        usage={"input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "cache_read_tokens": 0, "cache_creation_tokens": 0},
        generated_response=None,
        error=None,
    )


_FALLBACK_NODE_ID = "RESPONSE_GENERATOR"
_FALLBACK_NODE_TYPE = "RESPONSE_GENERATOR"
_FALLBACK_CONFIG = {
    "response_format": "text",
    "include_conversation_history": True,
    "is_streaming": True,
    "output_key": "generated_response",
    "input_template": "{original_query}",
}
_fallback_graph = None


def _get_fallback_graph():
    global _fallback_graph
    if _fallback_graph is None:
        builder = StateGraph(RetrievalState)
        builder.add_node(_FALLBACK_NODE_ID, make_llm_node(_FALLBACK_NODE_TYPE))
        builder.set_entry_point(_FALLBACK_NODE_ID)
        builder.add_edge(_FALLBACK_NODE_ID, END)
        _fallback_graph = builder.compile()
    return _fallback_graph


def _direct_graph() -> tuple:
    """Single-node direct-LLM pipeline: no retrieval, no intermediate nodes."""
    graph = _get_fallback_graph()
    node_type_map = {_FALLBACK_NODE_ID: _FALLBACK_NODE_TYPE}
    node_configs = {_FALLBACK_NODE_TYPE: _FALLBACK_CONFIG}
    streaming_nodes = {_FALLBACK_NODE_ID}
    return graph, node_type_map, node_configs, streaming_nodes, _DEFAULT_MAX_ITERATIONS


def _resolve_graph(customer_id: str) -> tuple:
    """
    Load the customer's dynamic graph from DDB.
    Falls back to a single direct-LLM node when no graph is configured.
    Returns (graph, node_type_map, node_configs, streaming_nodes).
    """
    graph_data = get_default_graph_and_nodes(customer_id)
    if graph_data is None:
        logger.info("No graph found for customer=%s — falling back to direct LLM", customer_id)
        return _direct_graph()

    graph_record, nodes = graph_data
    graph, max_iterations = get_or_build_graph(customer_id, graph_record, nodes)

    node_type_map = {n["nodeId"]: n["nodeType"] for n in nodes}
    node_configs = {}
    streaming_nodes: set[str] = set()
    for n in nodes:
        config = json.loads(n.get("config") or "{}")
        node_configs[n["nodeType"]] = config
        if config.get("is_streaming"):
            streaming_nodes.add(n["nodeId"])

    return graph, node_type_map, node_configs, streaming_nodes, max_iterations


@router.post("/retrieve")
async def retrieve(req: RetrieveRequest):
    # Anchor for the "thinking" duration: request receipt → first generated token
    request_start = time.monotonic()
    creds_keys = list(req.llm_credentials.keys())
    logger.info(
        "Incoming /retrieve — customer=%s client=%s provider=%s stream=%s agentic=%s "
        "query='%s' credential_keys=%s has_system_prompt=%s system_prompt_len=%d "
        "system_prompt=%r",
        req.customer_id,
        req.client,
        req.llm_provider,
        req.stream,
        req.agentic,
        req.raw_data.query_data[:80],
        creds_keys,
        bool(req.system_prompt),
        len(req.system_prompt) if req.system_prompt else 0,
        req.system_prompt,
    )

    if req.agentic:
        graph, node_type_map, node_configs, streaming_nodes, max_iterations = _resolve_graph(req.customer_id)
    else:
        graph, node_type_map, node_configs, streaming_nodes, max_iterations = _direct_graph()
    state = _build_state(req, node_configs)
    run_config = {"recursion_limit": max_iterations}

    if req.stream:
        logger.info("Returning StreamingResponse for customer=%s", req.customer_id)
        return StreamingResponse(
            stream_response(state, graph=graph, node_type_map=node_type_map, streaming_nodes=streaming_nodes, recursion_limit=max_iterations, request_start=request_start),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    logger.info("Invoking graph (non-streaming) for customer=%s", req.customer_id)
    try:
        result = await graph.ainvoke(state, config=run_config)
        usage = result.get("usage", {})
        logger.info(
            "Graph completed (non-streaming) — has_response=%s error=%s "
            "input_tokens=%s output_tokens=%s total_tokens=%s",
            bool(result.get("generated_response")),
            result.get("error"),
            usage.get("input_tokens"),
            usage.get("output_tokens"),
            usage.get("total_tokens"),
        )
        return JSONResponse({
            "customer_id": result["customer_id"],
            "generated_response": result.get("generated_response"),
            "tool_calls": result.get("tool_calls"),
            "retrieval_results": result.get("ranked_results") or result.get("retrieval_results", []),
            "rewritten_query": result.get("rewritten_query"),
            "error": result.get("error"),
            "usage": usage,
        })
    except Exception as e:
        logger.error("Graph invocation failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Graph error: {e}")
