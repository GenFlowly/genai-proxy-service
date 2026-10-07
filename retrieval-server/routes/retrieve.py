import json
import logging
import time

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from langgraph.graph import END, StateGraph

from graph.dynamic_graph import get_or_build_graph, _DEFAULT_MAX_ITERATIONS
from graph.graph_loader import get_default_graph_and_nodes, get_graph_and_nodes_by_id
from graph.instruction_loader import get_instruction_text
from graph.tools_runtime import all_builtin_tool_names
from graph.nodes.llm_node import make_llm_node
from graph.nodes.memory import memory
from graph.state import RetrievalState
from models import ExecuteAgentGraphRequest, RetrieveRequest
from streaming import stream_response

logger = logging.getLogger(__name__)

router = APIRouter()


def _enabled_builtin_tools(node_type_map: dict, node_configs: dict) -> list[str]:
    """Tool names enabled by the graph's TOOL_EXECUTOR node(s): the node
    config's "tools" list, or every BUILT-IN tool when unspecified.
    No TOOL_EXECUTOR node → no tools bound.

    The unspecified case deliberately falls back to built-ins only. Built-ins
    are first-party code we ship, so enabling them implicitly is safe and
    preserves the behavior existing graphs rely on. A customer-defined tool
    must always be named explicitly, so adding one can never silently widen
    what an existing agent is allowed to call.
    """
    enabled: list[str] = []
    for node_id, node_type in node_type_map.items():
        if node_type != "TOOL_EXECUTOR":
            continue
        names = node_configs.get(node_id, {}).get("tools")
        if names is None:
            names = all_builtin_tool_names()
        enabled.extend(n for n in names if n not in enabled)
    return enabled


def _build_state(req: RetrieveRequest, node_configs: dict, builtin_tools: list[str]) -> RetrievalState:
    return RetrievalState(
        customer_id=req.customer_id,
        client=req.client,
        data_type=req.data_type,
        request_source=req.request_source,
        model_type=req.model_type,
        model_name=req.model_name,
        original_query=req.raw_data.query_data,
        query_images=[img.model_dump() for img in req.raw_data.images],
        tools=[t.model_dump() for t in req.tools],
        tool_choice=req.tool_choice,
        query_tool_results=[r.model_dump() for r in req.tool_results],
        builtin_tools=builtin_tools,
        loop_messages=[],
        generated_artifacts=[],
        response_schema=req.response_schema,
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
        web_search_results=[],
        web_search_answer=None,
        usage={"input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "cache_read_tokens": 0, "cache_creation_tokens": 0, "reasoning_tokens": 0},
        memory_enabled=req.memory_enabled,
        memories_block=None,
        trace=[],
        scratch={},
        generated_response=None,
        error=None,
        agent_depth=0,
    )


_FALLBACK_NODE_ID = "RESPONSE_GENERATOR"
_FALLBACK_MEMORY_NODE_ID = "MEMORY"
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
        # MEMORY first so learned user facts reach the persona even on the
        # direct (non-agentic / graphless) path; inert without consent.
        builder.add_node(_FALLBACK_MEMORY_NODE_ID, memory(_FALLBACK_MEMORY_NODE_ID))
        builder.add_node(_FALLBACK_NODE_ID, make_llm_node(_FALLBACK_NODE_TYPE))
        builder.set_entry_point(_FALLBACK_MEMORY_NODE_ID)
        builder.add_edge(_FALLBACK_MEMORY_NODE_ID, _FALLBACK_NODE_ID)
        builder.add_edge(_FALLBACK_NODE_ID, END)
        _fallback_graph = builder.compile()
    return _fallback_graph


def _direct_graph() -> tuple:
    """Direct-LLM pipeline: memory + one generation node, no retrieval."""
    graph = _get_fallback_graph()
    node_type_map = {
        _FALLBACK_MEMORY_NODE_ID: "MEMORY",
        _FALLBACK_NODE_ID: _FALLBACK_NODE_TYPE,
    }
    node_name_map = {
        _FALLBACK_MEMORY_NODE_ID: "Memory",
        _FALLBACK_NODE_ID: "Response Generator",
    }
    node_configs = {_FALLBACK_NODE_TYPE: _FALLBACK_CONFIG}
    streaming_nodes = {_FALLBACK_NODE_ID}
    return graph, node_type_map, node_name_map, node_configs, streaming_nodes, _DEFAULT_MAX_ITERATIONS


def _build_node_configs(nodes: list[dict]) -> tuple[dict, dict, set[str]]:
    """
    Per-request node config dicts keyed by nodeId (plus a nodeType-keyed alias
    for the first node of each type), with centralized system prompts
    resolved: an instruction reference beats the node's inline system_prompt,
    which beats the hardcoded defaults in the node implementations.
    Unresolvable refs degrade gracefully.
    Returns (node_type_map, node_configs, streaming_node_ids).
    """
    node_type_map = {n["nodeId"]: n["nodeType"] for n in nodes}
    node_configs: dict = {}
    streaming_nodes: set[str] = set()
    for n in nodes:
        config = json.loads(n.get("config") or "{}")
        instruction_id = config.get("instruction_id")
        if instruction_id:
            version = config.get("instruction_version")
            text = get_instruction_text(instruction_id, int(version) if version is not None else None)
            if text is not None:
                config["system_prompt"] = text
            else:
                logger.warning(
                    "Node %s: instruction %s v%s unresolvable — using inline prompt",
                    n["nodeId"], instruction_id, version,
                )
        # Agent-harness scaffolding as a versioned instruction record: resolves
        # into config["harness_prompt"], which llm_node prepends to the persona
        # on response generators. An unresolvable ref degrades to the inline
        # harness_prompt (if any) rather than failing the request.
        harness_ref = config.get("harness_instruction_id")
        if harness_ref:
            version = config.get("harness_instruction_version")
            text = get_instruction_text(harness_ref, int(version) if version is not None else None)
            if text is not None:
                config["harness_prompt"] = text
            else:
                logger.warning(
                    "Node %s: harness instruction %s v%s unresolvable — using inline harness prompt",
                    n["nodeId"], harness_ref, version,
                )
        # Keyed by node identity — the same nodeType can appear many times with
        # different configs. The first node of each type also lands under the
        # type key for legacy lookups (e.g. {web_context}'s citation config).
        node_configs[n["nodeId"]] = config
        node_configs.setdefault(n["nodeType"], config)
        if config.get("is_streaming"):
            streaming_nodes.add(n["nodeId"])
    return node_type_map, node_configs, streaming_nodes


def _resolve_graph(customer_id: str, graph_id: str | None = None) -> tuple:
    """
    Load the customer's dynamic graph from DDB — the explicitly requested
    graph_id when given (own-or-System ownership re-checked here as defense in
    depth; a 404/foreign graph raises 400), otherwise the customer's default.
    Falls back to a single direct-LLM node when no graph is configured.
    Returns (graph, node_type_map, node_configs, streaming_nodes).
    """
    if graph_id:
        graph_data = get_graph_and_nodes_by_id(graph_id)
        owner = graph_data[0].get("customerId") if graph_data else None
        if graph_data is None or owner not in (customer_id, "System"):
            logger.warning("Requested graph=%s not accessible for customer=%s", graph_id, customer_id)
            raise HTTPException(status_code=400, detail=f"Agent '{graph_id}' not found")
    else:
        graph_data = get_default_graph_and_nodes(customer_id)
    if graph_data is None:
        logger.info("No graph found for customer=%s — falling back to direct LLM", customer_id)
        return _direct_graph()

    graph_record, nodes = graph_data
    # Compiled-graph cache key: per-graph for explicit selections so switching
    # agents between requests doesn't thrash the per-customer entry.
    cache_key = f"graph#{graph_id}" if graph_id else customer_id
    graph, max_iterations = get_or_build_graph(cache_key, graph_record, nodes)
    node_type_map, node_configs, streaming_nodes = _build_node_configs(nodes)
    node_name_map = {n["nodeId"]: n.get("name") or n["nodeType"] for n in nodes}

    return graph, node_type_map, node_name_map, node_configs, streaming_nodes, max_iterations


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

    if req.response_schema and req.tools:
        raise HTTPException(
            status_code=400,
            detail="response_schema and tools are mutually exclusive — structured output "
                   "reserves the vendor's tool/format channel for the schema",
        )

    if req.agentic:
        graph, node_type_map, node_name_map, node_configs, streaming_nodes, max_iterations = _resolve_graph(req.customer_id, req.graph_id)
    else:
        graph, node_type_map, node_name_map, node_configs, streaming_nodes, max_iterations = _direct_graph()
    builtin_tools = _enabled_builtin_tools(node_type_map, node_configs)
    state = _build_state(req, node_configs, builtin_tools)
    run_config = {"recursion_limit": max_iterations}

    if req.stream:
        logger.info("Returning StreamingResponse for customer=%s", req.customer_id)
        return StreamingResponse(
            stream_response(state, graph=graph, node_type_map=node_type_map, node_name_map=node_name_map, streaming_nodes=streaming_nodes, recursion_limit=max_iterations, request_start=request_start, structured_output=bool(req.response_schema), builtin_tool_names=set(builtin_tools)),
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
            "generated_artifacts": result.get("generated_artifacts", []),
            "retrieval_results": result.get("ranked_results") or result.get("retrieval_results", []),
            # Numbered to match the [n] citation markers the response generator
            # emits when a WEB_SEARCH node ran (see _build_web_context).
            "web_search_results": result.get("web_search_results", []),
            "rewritten_query": result.get("rewritten_query"),
            "error": result.get("error"),
            "usage": usage,
        })
    except Exception as e:
        logger.error("Graph invocation failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Graph error: {e}")


@router.post("/execute-agent-graph")
async def execute_agent_graph(req: ExecuteAgentGraphRequest):
    """
    Execute a specific agent graph (request agents — titles, personas, …)
    through the same LangGraph runtime that serves customer chat, so
    multi-node request agents genuinely run as graphs. The caller supplies
    provider/credentials (failover stays in the proxy server) and reads the
    final state's generated_response.
    """
    graph_data = get_graph_and_nodes_by_id(req.graph_id)
    if graph_data is None:
        raise HTTPException(status_code=404, detail=f"graph {req.graph_id} not found")
    graph_record, nodes = graph_data
    graph, max_iterations = get_or_build_graph(f"graph#{req.graph_id}", graph_record, nodes)
    _, node_configs, _ = _build_node_configs(nodes)

    # node_configs carries each dict under its nodeId AND (first per type) its
    # nodeType — dedupe to the unique config objects before mutating them.
    unique_configs = list({id(c): c for c in node_configs.values()}.values())

    # GENERATION nodes store executor-style config keys; adapt each one to the
    # llm_node contract. Their output is the graph's result by convention.
    for n in nodes:
        if n["nodeType"] != "GENERATION":
            continue
        config = node_configs[n["nodeId"]]
        config.setdefault("output_key", "generated_response")
        config.setdefault("response_format", "text")
        config.setdefault("include_conversation_history", False)

    # Render {name} variables into every node's prompt templates up front —
    # the LangGraph state schema is fixed, so variables can't ride through
    # state. Runtime placeholders ({context}, {query}, custom scratch keys, …)
    # are left for the node's own _render_template pass.
    for config in unique_configs:
        for key in ("system_prompt", "input_template"):
            template = config.get(key)
            if isinstance(template, str):
                for name, value in req.variables.items():
                    template = template.replace("{%s}" % name, value)
                config[key] = template

    # Response-producing nodes take their persona from request_system_prompt
    # (node-level prompts are ignored there, by design of the chat path) —
    # lift the producing node's resolved prompt into that slot.
    response_prompt = None
    for config in unique_configs:
        if config.get("output_key") == "generated_response" and config.get("system_prompt"):
            response_prompt = config["system_prompt"]
            break

    state = RetrievalState(
        customer_id=req.customer_id,
        client=req.client,
        data_type="internal",
        request_source=req.request_source,
        model_type=req.model_type,
        model_name=req.model_name,
        original_query=req.variables.get("original_query", ""),
        query_images=[],
        tools=[],
        tool_choice=None,
        query_tool_results=[],
        builtin_tools=[],
        loop_messages=[],
        generated_artifacts=[],
        response_schema=req.response_schema,
        tool_calls=None,
        rewritten_query=None,
        needs_rewrite=False,
        query_intent=None,
        top_n=req.top_n,
        search_params={"metric_type": "COSINE", "params": {"nprobe": 10}},
        similarity_threshold=0.6,
        llm_credentials=req.llm_credentials,
        llm_provider=req.llm_provider,
        llm_model=req.llm_model,
        llm_max_tokens=req.llm_max_tokens,
        conversation_history=[],
        node_configs=node_configs,
        request_system_prompt=response_prompt,
        retrieval_results=[],
        ranked_results=[],
        web_search_results=[],
        web_search_answer=None,
        usage={"input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "cache_read_tokens": 0, "cache_creation_tokens": 0, "reasoning_tokens": 0},
        memory_enabled=req.memory_enabled,
        memories_block=None,
        trace=[],
        scratch={},
        generated_response=None,
        error=None,
        agent_depth=0,
    )

    logger.info(
        "Executing agent graph %s for customer=%s (%d node(s), provider=%s)",
        req.graph_id, req.customer_id, len(nodes), req.llm_provider,
    )
    try:
        result = await graph.ainvoke(state, config={"recursion_limit": max_iterations})
        return JSONResponse({
            "generated_response": result.get("generated_response"),
            "error": result.get("error"),
            "usage": result.get("usage", {}),
        })
    except Exception as e:
        logger.error("Agent graph %s execution failed: %s", req.graph_id, e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Graph error: {e}")
