"""McpTool: tools exposed by a Model Context Protocol server.

One record is one SERVER, which exposes many tools, so this provider expands a
record into several GraphTools named `<record>_<tool>`. That namespacing is not
cosmetic: two servers may both expose `search`, and the model must be able to
tell them apart.

Two decisions shape everything here.

**Binding reads a pinned manifest; it never calls the server.**
The tools a server offers are captured when the customer CONNECTS it and stored
on the record as `discoveredTools`. Binding is then a dict read. Discovering at
bind time instead would put a network round trip on the critical path of every
request, and would let a server silently change what its tools claim to do
between one turn and the next. Since a tool's `description` is text we place
directly into the model's context, a server that can rewrite it at will can
steer the agent — prompt injection through a channel the customer never sees.
Pinning means a changed manifest is a change the customer re-approves, not one
that lands mid-conversation.

**Anything the server says about itself is data, never instruction.**
MCP servers may return `instructions` at initialization. That text is discarded
here rather than merged into any prompt: it is a third party writing into our
system prompt. Tool RESULTS are likewise just tool results, exactly as an HTTP
tool's response body is.

This talks to the `mcp` SDK directly rather than through langchain-mcp-adapters.
We already have our own tool contract, so the adapter would only add a layer —
and it currently pins `mcp<2.0.0` while the SDK is on 2.x, where the transport
entry point was renamed. Depending on the SDK we actually use keeps us current.
"""
import logging
from typing import Any

from graph_tools.base import GraphTool, ToolContext, ToolResult
from graph_tools.providers.http_tool import ToolDefinitionError, as_dict
from graph_tools.providers.safe_client import UnsafeRequestError, redact, validate_url
from graph_tools.providers.template import (
    TemplateError,
    has_placeholder,
    render_mapping,
)

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT_SECONDS = 30.0
MAX_RESULT_CHARS = 16000

# The separator between a record's name and a server-side tool name. Underscore
# keeps the result inside the [a-z0-9_] alphabet every vendor accepts.
NAME_SEPARATOR = "_"


def _flatten_content(content: Any) -> str:
    """Render an MCP result's content blocks as text for the model.

    Non-text blocks are named rather than dropped silently, so a model that
    receives an image does not think the call returned nothing.
    """
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    parts: list[str] = []
    for block in content if isinstance(content, (list, tuple)) else [content]:
        text = getattr(block, "text", None)
        if text is not None:
            parts.append(str(text))
            continue
        kind = getattr(block, "type", None) or type(block).__name__
        parts.append(f"[{kind} content omitted]")
    return "\n".join(p for p in parts if p)


class McpTool(GraphTool):
    """One tool on one MCP server, bound from that server's pinned manifest."""

    def __init__(
        self,
        *,
        local_name: str,
        remote_name: str,
        description: str,
        parameters: dict,
        url: str,
        header_templates: dict | None = None,
        credential_ref: str | None = None,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
    ):
        self.name = local_name
        self.remote_name = remote_name
        self.description = description
        self.parameters = parameters
        self.url = url
        self.header_templates = header_templates or {}
        self.credential_ref = credential_ref or None
        self.timeout = timeout

    async def run(self, args: dict, context: ToolContext) -> ToolResult:
        credentials = context.secrets(self.credential_ref) if self.credential_ref else {}
        if self.credential_ref and not credentials:
            return ToolResult(content=(
                f"'{self.name}' is not connected yet — no credentials are stored for it. "
                "Tell the user to connect it in Settings, then try again."
            ))

        try:
            headers = render_mapping(self.header_templates, args or {}, credentials or {})
        except TemplateError as e:
            return ToolResult(content=f"Could not build the request for '{self.name}': {e}")

        # Same destination rules as the HTTP tier: https, and never an address
        # on our own network.
        try:
            validate_url(self.url)
        except UnsafeRequestError as e:
            logger.warning("McpTool %s: refused — %s", self.name, e)
            return ToolResult(content=f"'{self.name}' could not be called: {e}")

        logger.info(
            "McpTool %s: customer=%s calling %s on %s",
            self.name, context.customer_id, self.remote_name, self.url,
        )
        try:
            result = await self._call(headers, args or {})
        except Exception as e:
            # An upstream error can quote the credential back at us.
            logger.error(
                "McpTool %s: failed — %s",
                self.name, redact(e, (credentials or {}).values()),
            )
            return ToolResult(content=(
                f"'{self.name}' failed to reach its server. Try again, or answer "
                "without it and say the call did not go through."
            ))

        text = _flatten_content(getattr(result, "content", None))
        if getattr(result, "is_error", False):
            return ToolResult(content=f"'{self.name}' reported an error: {text[:2000]}")
        if not text:
            structured = getattr(result, "structured_content", None)
            if structured:
                import json

                text = json.dumps(structured, indent=2, default=str)
        if len(text) > MAX_RESULT_CHARS:
            text = text[:MAX_RESULT_CHARS] + "\n\n[truncated]"
        return ToolResult(content=text or "The call succeeded but returned no content.")

    async def _call(self, headers: dict, args: dict):
        """One request-scoped connection.

        A connection per call rather than a pooled session: the durable runtime
        can resume a run hours later in a different process, so there is no
        session worth keeping, and a long-lived connection per customer per
        server would be state this process must not own.
        """
        from mcp import Client
        from mcp.client.streamable_http import (
            create_mcp_http_client,
            streamable_http_client,
        )

        # The transport is built explicitly rather than handing Client a URL
        # string: that convenience path constructs its own http client, so the
        # auth headers would never be sent.
        transport = streamable_http_client(
            self.url,
            http_client=create_mcp_http_client(headers=headers or None),
        )
        async with Client(
            transport,
            read_timeout_seconds=self.timeout,
            # No sampling callback, no roots, no elicitation: the server gets no
            # way to call back into us or to read anything it was not asked for.
        ) as client:
            return await client.call_tool(self.remote_name, args)


def _tool_name(record_name: str, remote_name: str) -> str:
    cleaned = "".join(c if c.isalnum() or c == "_" else "_" for c in remote_name).strip("_")
    return f"{record_name}{NAME_SEPARATOR}{cleaned}".lower()[:64]


def mcp_tools_from_record(record: dict) -> dict[str, GraphTool]:
    """Expand one MCP server record into {model-facing name: tool}.

    Reads the manifest pinned on the record. A record with no pinned manifest
    yields nothing: it has been connected but not yet approved, and guessing
    would mean calling the server during a request.
    """
    record_name = (record.get("name") or "").strip()
    if not record_name:
        raise ToolDefinitionError("name is required")

    request = as_dict(record.get("request"), "request")
    url = (request.get("url") or "").strip()
    if not url:
        raise ToolDefinitionError(f"MCP tool '{record_name}' has no server url")
    if not url.startswith("https://"):
        raise ToolDefinitionError(
            f"MCP tool '{record_name}' must use an https server url"
        )
    if has_placeholder(url):
        raise ToolDefinitionError(
            f"MCP tool '{record_name}' may not template its server url"
        )

    headers = request.get("headers") or {}
    credential_ref = (record.get("credentialRef") or "").strip() or None
    try:
        timeout = float(request.get("timeoutSeconds") or DEFAULT_TIMEOUT_SECONDS)
    except (TypeError, ValueError):
        timeout = DEFAULT_TIMEOUT_SECONDS
    timeout = max(1.0, min(timeout, 120.0))

    discovered = record.get("discoveredTools")
    if isinstance(discovered, str):
        import json

        try:
            discovered = json.loads(discovered)
        except json.JSONDecodeError as e:
            raise ToolDefinitionError(
                f"MCP tool '{record_name}' has a malformed discoveredTools manifest"
            ) from e
    if not discovered:
        logger.warning(
            "MCP record '%s' has no pinned manifest — connect and approve it before use",
            record_name,
        )
        return {}
    if not isinstance(discovered, list):
        raise ToolDefinitionError(
            f"MCP tool '{record_name}' discoveredTools must be a list"
        )

    built: dict[str, GraphTool] = {}
    for entry in discovered:
        if not isinstance(entry, dict):
            continue
        remote_name = (entry.get("name") or "").strip()
        if not remote_name:
            continue
        schema = entry.get("inputSchema") or entry.get("input_schema") or {}
        if isinstance(schema, str):
            import json

            try:
                schema = json.loads(schema)
            except json.JSONDecodeError:
                schema = {}
        if not isinstance(schema, dict) or schema.get("type") != "object":
            schema = {"type": "object", "properties": {}}
        local = _tool_name(record_name, remote_name)
        if local in built:
            continue
        built[local] = McpTool(
            local_name=local,
            remote_name=remote_name,
            description=(entry.get("description") or f"{remote_name} via {record_name}").strip(),
            parameters=schema,
            url=url,
            header_templates=headers,
            credential_ref=credential_ref,
            timeout=timeout,
        )
    return built
