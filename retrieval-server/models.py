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


class FileRef(BaseModel):
    """A non-image file of the conversation (plan 3.1): a file a built-in tool
    generated on an assistant turn (origin "generated", e.g. a PDF) or a
    document the user attached (origin "uploaded"). Only references travel in
    requests, state and durable-run inputs, never file bytes.

    s3_key is the key the proxy stored, used exactly as given: in a shared
    conversation the file can sit under another participant's prefix, so a key
    is never rebuilt from attachment_id."""
    attachment_id: str
    s3_key: str
    media_type: str
    filename: Optional[str] = None
    size_bytes: Optional[int] = None
    origin: str = "uploaded"


class RawData(BaseModel):
    query_data: str
    top_n: int = 3
    search_params: dict = {"metric_type": "COSINE", "params": {"nprobe": 10}}
    similarity_threshold: float = 0.6
    # Images attached to the current-turn query
    images: list[ImageRef] = []
    # Non-image files attached to the current-turn query (uploaded documents)
    files: list[FileRef] = []
    # First language tag of the user's browser (Accept-Language), e.g. "en-US";
    # drives a generated PDF's page size and footer language (plan 6.1).
    locale: Optional[str] = None
    # Scratch namespace the proxy minted for this request, under which the
    # turn's agent-fs objects are written (so it can record them, plan 1.16);
    # None lets the executor mint one.
    fs_namespace: Optional[str] = None


class ConversationMessage(BaseModel):
    role: str
    content: str
    images: list[ImageRef] = []
    # Assistant turns: tool calls the model made — [{id, name, args}, ...]
    tool_calls: Optional[list] = None
    # User turns: results for the preceding assistant turn's tool calls
    tool_results: Optional[list] = None
    # Non-image files of the turn: generated files on assistant turns,
    # uploaded documents on user turns (plan 3.1).
    files: list[FileRef] = []


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
    # Explicit agent graph to run instead of the customer's default. The proxy
    # validates access (own-or-System) before sending; ownership is re-checked
    # here as defense in depth. None → default resolution.
    graph_id: Optional[str] = None
    # End user's per-request reasoning depth ("none"|"low"|"medium"|"high",
    # from the AI-config surfaces). On the response generator it overrides the
    # node config's thinking_level; pipeline nodes ignore it. Invalid values
    # are warned-and-ignored downstream (llm_node), never an error.
    thinking_level: Optional[str] = None
    # The PDF renderer pinned when the turn started (graph/pdf_renderer.py).
    # Declared so a durable run rebuilt from its stored input keeps it; the
    # /retrieve handler overwrites whatever a caller sends. (Stored input
    # from before plan 5.2 may also carry pdf_script_route: an undeclared
    # key, ignored on validation.)
    pdf_renderer: Optional[str] = None


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
    graph_id: Optional[str] = None
    # Same semantics as RetrieveRequest.thinking_level.
    thinking_level: Optional[str] = None
    # Pinned by POST /runs before the run is enqueued (graph/pdf_renderer.py);
    # a value a caller sends is overwritten.
    pdf_renderer: Optional[str] = None
    # Optional client-supplied run id for idempotency / rediscovery. When set it
    # becomes the DBOS workflow id (a duplicate re-attaches to the same run
    # instead of starting a new one). Server-generated when omitted.
    run_id: Optional[str] = None
