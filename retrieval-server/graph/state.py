from typing import TypedDict, Optional, Annotated

def _merge_scratch(current: dict, update: dict) -> dict:
    """Last-writer-wins merge for the free-form scratch channel."""
    return {**(current or {}), **(update or {})}


def _append_list(current: list, update: list) -> list:
    return (current or []) + (update or [])


def _merge_usage(current: dict, update: dict) -> dict:
    return {
        "input_tokens": current.get("input_tokens", 0) + update.get("input_tokens", 0),
        "output_tokens": current.get("output_tokens", 0) + update.get("output_tokens", 0),
        "total_tokens": current.get("total_tokens", 0) + update.get("total_tokens", 0),
        "cache_read_tokens": current.get("cache_read_tokens", 0) + update.get("cache_read_tokens", 0),
        "cache_creation_tokens": current.get("cache_creation_tokens", 0) + update.get("cache_creation_tokens", 0),
        "reasoning_tokens": current.get("reasoning_tokens", 0) + update.get("reasoning_tokens", 0),
    }


class RetrievalState(TypedDict):
    # Identity
    customer_id: str
    client: str
    data_type: str
    # What the LLM calls in this run serve — "conversation" for user chat, a
    # RequestType (conversation_title, instruction_persona, memory_extraction,
    # ...) for internal generations. Metric dimension (`source`) on
    # llm_request_total; bounded set, forwarded from the proxy.
    request_source: str

    # Embedding model
    model_type: Optional[str]
    model_name: Optional[str]

    # Query
    original_query: str
    rewritten_query: Optional[str]
    needs_rewrite: bool
    query_intent: Optional[str]

    # Search params
    top_n: int
    search_params: dict
    similarity_threshold: float

    # LLM config — credentials forwarded from genai-proxy-service, provider selected per request
    # keys: openai_api_key, anthropic_api_key, gemini_api_key, ...
    # Set on the stateless /retrieve path (creds supplied in the request). The
    # durable /runs path deliberately LEAVES THIS UNSET so no secret is ever
    # checkpointed; nodes then resolve creds from DynamoDB by customer_id via
    # graph.credentials.credentials_for(state).
    llm_credentials: dict
    llm_provider: str      # "openai" | "anthropic" | "gemini"
    llm_model: Optional[str]  # model name forwarded from request (e.g. "gpt-4o", "claude-sonnet-4-6")
    llm_max_tokens: Optional[int]  # max tokens for generation, defaults to 4096
    conversation_history: list  # prior + current turns: [{role, content, images?}, ...]

    # Images attached to the current-turn query: [{s3_key, media_type}, ...].
    # Only the response-generator node sends them to the LLM (retrieval/ranking
    # nodes stay text-only).
    query_images: list

    # Caller-defined tools: [{name, description, parameters}, ...]. Bound only to
    # the response-generator node (text format); other nodes never see them.
    tools: list
    tool_choice: Optional[str]
    # Current-turn tool results: [{tool_call_id, content}, ...] — become
    # ToolMessages directly after the assistant turn that made the calls.
    query_tool_results: list

    # Built-in tool names (graph_tools registry) enabled for this request —
    # derived from the graph's TOOL_EXECUTOR node config. The response
    # generator binds their specs alongside caller-defined tools; the
    # TOOL_EXECUTOR node executes their calls in-graph.
    builtin_tools: list

    # In-graph agent-loop turns for the CURRENT request, appended after the
    # current user message on each generator run:
    #   {role: "assistant", content, tool_calls} — the turn that made the calls
    #   {role: "tool", tool_call_id, content}    — each executed result
    # Written by the TOOL_EXECUTOR node; distinct from query_tool_results,
    # which replays caller-executed results from the previous API request.
    loop_messages: Annotated[list, _append_list]

    # Files produced by built-in tools this request: [{artifact_id, key,
    # media_type, filename, size_bytes}, ...]. The proxy server persists them
    # as attachments on the assistant message.
    generated_artifacts: Annotated[list, _append_list]

    # Citable sources any built-in tool grounded its results in this request:
    # [{index, title, url}, ...] with a turn-global 1-based index. The
    # TOOL_EXECUTOR node owns numbering and writes the FULL accumulated snapshot
    # each round (plain overwrite, NOT an append reducer) so the streaming layer
    # can emit the complete set as one `web_sources` event and the inline [n]
    # markers in the answer line up with it. Distinct from web_search_results,
    # which the legacy WEB_SEARCH *node* writes for graphs still using it.
    tool_sources: list

    # JSON Schema the response generator's output must conform to (structured
    # output). Only the response-generator node honors it; mutually exclusive
    # with tools. None → free-text generation.
    response_schema: Optional[dict]

    # Per-node config loaded from DDB CustomerGraphNodes.config. Keyed by
    # nodeId (each node instance has its own config — the same nodeType can
    # appear many times with different purposes) with a nodeType-keyed entry
    # kept as fallback for the static fallback/voice graphs.
    node_configs: dict  # e.g. {"NOD123…": {"system_prompt": "...", "model_override": "gpt-4o"}}
                        # Response generators ignore system_prompt/model_override — see llm_node.py.

    # Customer instruction forwarded from genai-proxy-server (fetched via instructionId/instructionVersion).
    # When set, overrides the RESPONSE_GENERATOR node's configured system_prompt.
    request_system_prompt: Optional[str]

    # Working data
    retrieval_results: list
    ranked_results: list
    # Written by the WEB_SEARCH node: [{title, url, content, score}, ...] plus
    # Tavily's optional synthesized answer. Injected into prompts via the
    # {web_context} template variable.
    web_search_results: list
    web_search_answer: Optional[str]

    # Token usage accumulated across all LLM-calling nodes
    usage: Annotated[dict, _merge_usage]

    # Governance decision from the proxy server: MEMORY nodes may inject the
    # customer's learned memories (request consent AND account setting).
    memory_enabled: bool

    # Written by the MEMORY node: the rendered "what you know about this user"
    # block. The response-generating nodes append it to their persona.
    memories_block: Optional[str]

    # Execution trace for the client's "thinking" panel: one entry per
    # LLM-calling node — {node, prompt, response} (truncated). Appended by the
    # nodes, surfaced by the streaming layer as thinking_step events.
    trace: Annotated[list, _append_list]

    # Free-form state: node outputs whose output_key is not a first-class
    # field above land here ({key: value}), readable from any later node's
    # templates ({key}) and usable as conditional-edge condition keys. The
    # reducer merges writes so parallel/sequential nodes accumulate keys.
    scratch: Annotated[dict, _merge_scratch]

    # Output
    generated_response: Optional[str]
    # Tool calls the response generator's model made: [{id, name, args}, ...].
    # Returned to the caller, who executes them and continues via tool_results.
    tool_calls: Optional[list]
    error: Optional[str]

    # Cycle termination signal — written by RESPONSE_GENERATOR_WITH_REFLECTION.
    # True means the node decided it needs more context and the graph should loop back.
    # Must always be explicitly set to False to exit a cycle safely.
    needs_more_context: Optional[bool]
