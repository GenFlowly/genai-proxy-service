from typing import Optional
from pydantic import BaseModel


class ImageRef(BaseModel):
    """Reference to an image in the attachments S3 bucket; bytes are fetched at LLM-call time."""
    s3_key: str
    media_type: str


class FileRef(BaseModel):
    """Reference to a non-image document (PDF today) in the attachments S3
    bucket; bytes are fetched at LLM-call time and fed to the model as a native
    document block, page images, or extracted text depending on the model's
    capabilities. `filename` names the document in prompts and error messages."""
    s3_key: str
    media_type: str
    filename: Optional[str] = None


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
    # Non-image documents (PDFs) attached to the current-turn query
    files: list[FileRef] = []


class ConversationMessage(BaseModel):
    role: str
    content: str
    images: list[ImageRef] = []
    # Documents (PDFs) the user attached on this turn; replayed as a lightweight
    # note on later turns rather than re-sent in full.
    files: list[FileRef] = []
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
    # Run as a DBOS durable workflow when the durable runtime is up: LLM calls
    # become exactly-once steps with transient retry, and credentials are
    # resolved server-side from DynamoDB (llm_credentials is stripped before
    # the workflow input is checkpointed). The caller must only ask for this
    # when the credentials it would have sent ARE the customer's stored keys —
    # the proxy sends durable=false for its admin-panel system-key fallback.
    # With the runtime down/unconfigured, execution degrades to the plain
    # in-process path (fail-safe, same convention as /runs).
    durable: bool = False


class MemoryContext(BaseModel):
    """Where, and for which reply, memories are used (the proxy's
    MemoryContext). The MEMORY node applies Profile memories plus
    project_id's only, and keys the usage log it writes by
    response_message_id and turn_started_at, so a retried or failed-over call
    for the same reply counts each memory once."""
    project_id: Optional[str] = None
    conversation_id: str
    response_message_id: str
    turn_started_at: str


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
    # Sent with memory_enabled: the conversation's project and the reply, for
    # memory scoping and the usage log.
    memory_context: Optional[MemoryContext] = None
    # Explicit agent graph to run instead of the customer's default. The proxy
    # validates access (own-or-System) before sending; ownership is re-checked
    # here as defense in depth. None → default resolution.
    graph_id: Optional[str] = None
    # End user's per-request reasoning depth ("none"|"low"|"medium"|"high",
    # from the AI-config surfaces). On the response generator it overrides the
    # node config's thinking_level; pipeline nodes ignore it. Invalid values
    # are warned-and-ignored downstream (llm_node), never an error.
    thinking_level: Optional[str] = None


class RunRequest(BaseModel):
    """Start a durable agent run (POST /runs). Same shape as RetrieveRequest
    minus `llm_credentials` (resolved server-side from DynamoDB by customer_id,
    never sent or checkpointed — see DURABLE_AGENTS_DBOS_PLAN §5.5) and `stream`
    (durable runs are always streamed via the reattachable /runs/{id}/stream).
    Fields map 1:1 onto RetrievalState via the same builder as /retrieve."""
    customer_id: str
    client: str
    data_type: str
    request_source: str = "conversation"
    raw_data: RawData
    llm_provider: str = "openai"
    llm_model: Optional[str] = None
    llm_max_tokens: int = 4096
    conversation_history: list[ConversationMessage] = []
    model_type: Optional[str] = None
    model_name: Optional[str] = None
    system_prompt: Optional[str] = None
    agentic: bool = True
    tools: list[ToolDefinition] = []
    tool_choice: Optional[str] = None
    tool_results: list[ToolResult] = []
    response_schema: Optional[dict] = None
    memory_enabled: bool = False
    memory_context: Optional[MemoryContext] = None
    graph_id: Optional[str] = None
    # Same semantics as RetrieveRequest.thinking_level.
    thinking_level: Optional[str] = None
    # Optional client-supplied run id for idempotency / rediscovery. When set it
    # becomes the DBOS workflow id (a duplicate re-attaches to the same run
    # instead of starting a new one). Server-generated when omitted.
    run_id: Optional[str] = None
