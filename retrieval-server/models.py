from typing import Optional
from pydantic import BaseModel


class ImageRef(BaseModel):
    """Reference to an image in the attachments S3 bucket; bytes are fetched at LLM-call time."""
    s3_key: str
    media_type: str


class ToolDefinition(BaseModel):
    """
    Caller-defined tool the LLM may call. Two flavors:
    - Function tool (type=None): `parameters` is a JSON Schema object; works on all vendors.
    - Native Anthropic tool (type set, e.g. "computer_20250124"): passed through
      untranslated with `options` (e.g. display_width_px) merged in; Claude only.
    """
    name: str
    description: str = ""
    parameters: dict = {}
    type: Optional[str] = None
    options: dict = {}


class ToolResultImage(BaseModel):
    """Image in a tool result (e.g. a computer-use screenshot). Exactly one of
    data (base64) or s3_key should be set; omitted marks a stripped historical image."""
    data: Optional[str] = None
    s3_key: Optional[str] = None
    media_type: str = "image/png"
    omitted: bool = False


class ToolResult(BaseModel):
    """Result of a tool call the caller executed, sent back to continue the turn."""
    tool_call_id: str
    content: str
    images: list[ToolResultImage] = []


class RawData(BaseModel):
    query_data: str
    top_n: int = 3
    search_params: dict = {"metric_type": "COSINE", "params": {"nprobe": 10}}
    similarity_threshold: float = 0.6
    # Images attached to the current-turn query
    images: list[ImageRef] = []


class ConversationMessage(BaseModel):
    role: str
    content: str
    images: list[ImageRef] = []
    # Assistant turns: tool calls the model made — [{id, name, args}, ...]
    tool_calls: Optional[list] = None
    # User turns: results for the preceding assistant turn's tool calls
    tool_results: Optional[list] = None


class ExecuteAgentGraphRequest(BaseModel):
    """
    Run a specific agent graph (by graphId, any owner) through the LangGraph
    runtime for an internal generation (titles, personas, …). Unifies request
    agents with the customer-chat pipeline: the proxy server picks the
    provider/credentials (with its own failover) and reads the final state's
    generated_response.
    """
    graph_id: str
    customer_id: str
    client: str = "internal"
    # Purpose label for metrics (llm_request_total{source=...}): the proxy's
    # RequestType lowercased (conversation_title, instruction_persona, ...).
    request_source: str = "internal"
    # Rendered into every node's system_prompt/input_template as {name}
    # placeholders BEFORE execution (the LangGraph state schema is fixed, so
    # variables cannot ride through state).
    variables: dict[str, str] = {}
    llm_credentials: dict
    llm_provider: str = "openai"
    llm_model: Optional[str] = None
    llm_max_tokens: int = 4096
    # Embedding config for RETRIEVAL nodes in the graph
    model_type: Optional[str] = None
    model_name: Optional[str] = None
    top_n: int = 3
    # JSON Schema for vendor-enforced structured output on the response node
    response_schema: Optional[dict] = None
    # Governance decision from the proxy server: MEMORY nodes may inject
    # learned user memories (request consent AND account setting).
    memory_enabled: bool = False


class RetrieveRequest(BaseModel):
    customer_id: str
    client: str
    data_type: str
    # Purpose label for metrics (llm_request_total{source=...}): "conversation"
    # for user chat; internal utility generations override it.
    request_source: str = "conversation"
    raw_data: RawData
    llm_credentials: dict
    llm_provider: str = "openai"
    llm_model: Optional[str] = None
    llm_max_tokens: int = 4096
    conversation_history: list[ConversationMessage] = []
    model_type: Optional[str] = None
    model_name: Optional[str] = None
    system_prompt: Optional[str] = None
    stream: bool = False
    # False → skip the customer's agent graph entirely and generate directly
    # from the LLM (no retrieval, no intermediate nodes).
    agentic: bool = True
    # Caller-defined tools, bound to the response generator across all vendors
    tools: list[ToolDefinition] = []
    # "auto" (default), "required"/"any", or a specific tool name
    tool_choice: Optional[str] = None
    # Results for the previous assistant message's tool calls (current turn)
    tool_results: list[ToolResult] = []
    # JSON Schema the response generator's output must conform to. Enforced via
    # each vendor's native structured-output mechanism (LangChain
    # with_structured_output), so the response is guaranteed-parseable JSON.
    # Mutually exclusive with `tools`. generated_response carries the JSON as a
    # string; streaming emits it as a single content chunk when generation ends.
    response_schema: Optional[dict] = None
    # Governance decision from the proxy server: MEMORY nodes may inject
    # learned user memories (request consent AND account setting).
    memory_enabled: bool = False
