from typing import TypedDict, Optional, Annotated

# TODO fix this to include cache
def _merge_usage(current: dict, update: dict) -> dict:
    return {
        "input_tokens": current.get("input_tokens", 0) + update.get("input_tokens", 0),
        "output_tokens": current.get("output_tokens", 0) + update.get("output_tokens", 0),
        "total_tokens": current.get("total_tokens", 0) + update.get("total_tokens", 0),
    }


class RetrievalState(TypedDict):
    # Identity
    customer_id: str
    client: str
    data_type: str

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
    llm_credentials: dict  # keys: openai_api_key, anthropic_api_key, gemini_api_key
    llm_provider: str      # "openai" | "anthropic" | "gemini"
    llm_model: Optional[str]  # model name forwarded from request (e.g. "gpt-4o", "claude-sonnet-4-6")
    llm_max_tokens: Optional[int]  # max tokens for generation, defaults to 4096
    conversation_history: list  # prior + current turns: [{role, content}, ...]

    # Per-node config loaded from DDB CustomerGraphNodes.config (keyed by nodeType).
    # Each node reads its own entry and falls back to built-in defaults when absent.
    node_configs: dict  # e.g. {"RESPONSE_GENERATOR": {"system_prompt": "...", "model_override": "gpt-4o"}}

    # Customer instruction forwarded from genai-proxy-server (fetched via instructionId/instructionVersion).
    # When set, overrides the RESPONSE_GENERATOR node's configured system_prompt.
    request_system_prompt: Optional[str]

    # Working data
    retrieval_results: list
    ranked_results: list

    # Token usage accumulated across all LLM-calling nodes
    usage: Annotated[dict, _merge_usage]

    # Output
    generated_response: Optional[str]
    error: Optional[str]

    # Cycle termination signal — written by RESPONSE_GENERATOR_WITH_REFLECTION.
    # True means the node decided it needs more context and the graph should loop back.
    # Must always be explicitly set to False to exit a cycle safely.
    needs_more_context: Optional[bool]
