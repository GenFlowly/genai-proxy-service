"""Connector endpoints: preview an API spec, discover an MCP server.

A connector is a thing you connect once that yields many tools. Both flows here
are the FIRST of two steps, and both are deliberately read-only: they fetch,
they parse, they return what the user would get, and they write nothing. The
second step — saving the chosen tools — belongs to the proxy, which owns
validation and storage.

Both take a URL the user typed, which is the whole reason these live here rather
than in the proxy or the browser: this is where the SSRF-hardened client is.
Every fetch goes through it, so a spec URL pointing at instance metadata or a
private address is refused before anything leaves the process.

Credential VALUES are never accepted in a request body. The caller names a
credential reference and this module resolves it from the customer's stored
blob, exactly as a real tool call does.
"""
import asyncio
import json
import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from graph.tool_credentials import resolve_tool_credentials
from graph_tools.providers import safe_client
from graph_tools.providers.mcp_tool import DEFAULT_TIMEOUT_SECONDS as MCP_TIMEOUT_SECONDS
from graph_tools.providers.openapi import SpecError, operations_from_spec
from graph_tools.providers.template import TemplateError, render_mapping

logger = logging.getLogger(__name__)

router = APIRouter()

# A spec is a document, not a download. Anything past this is a sign the URL is
# not what the user thinks it is.
_MAX_SPEC_BYTES = 4 * 1024 * 1024
_SPEC_TIMEOUT_SECONDS = 20.0


class OpenApiPreviewRequest(BaseModel):
    customer_id: str
    spec_url: str
    credential_ref: str = ""


class OpenApiOperation(BaseModel):
    name: str
    description: str
    method: str
    path: str
    parameters: dict
    request: dict
    responseTransform: dict
    warnings: list[str] = Field(default_factory=list)


class SkippedOperation(BaseModel):
    operationId: str
    reason: str


class OpenApiPreviewResponse(BaseModel):
    ok: bool
    title: str | None = None
    server_url: str | None = None
    operations: list[OpenApiOperation] = Field(default_factory=list)
    skipped: list[SkippedOperation] = Field(default_factory=list)
    error: str | None = None


class McpDiscoverRequest(BaseModel):
    customer_id: str
    server_url: str
    credential_ref: str = ""
    headers: dict = Field(default_factory=dict)


class McpDiscoveredTool(BaseModel):
    name: str
    description: str = ""
    inputSchema: dict = Field(default_factory=dict)


class McpDiscoverResponse(BaseModel):
    ok: bool
    server_name: str | None = None
    tool_count: int = 0
    tools: list[McpDiscoveredTool] = Field(default_factory=list)
    error: str | None = None


def _parse_spec_text(text: str) -> dict:
    """JSON first, then YAML if the document looks like YAML and PyYAML is
    present. A spec served as YAML is common enough to be worth handling, but
    not worth a hard dependency — PyYAML arrives via langchain-core anyway."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    try:
        import yaml
    except ImportError as e:
        raise SpecError(
            "That document is not JSON, and YAML specs are not supported here. "
            "Link the JSON version of the spec."
        ) from e
    try:
        loaded = yaml.safe_load(text)
    except Exception as e:
        raise SpecError("That document is neither valid JSON nor valid YAML.") from e
    if not isinstance(loaded, dict):
        raise SpecError("The spec did not parse into an object.")
    return loaded


@router.post("/connectors/openapi/preview")
async def preview_openapi(req: OpenApiPreviewRequest) -> OpenApiPreviewResponse:
    """Fetch an OpenAPI document and return the tools it would produce.

    Writes nothing. Everything it returns is a proposal the user approves.
    """
    if not req.customer_id:
        raise HTTPException(status_code=400, detail="customer_id is required")
    if not req.spec_url:
        return OpenApiPreviewResponse(ok=False, error="Enter the URL of the API's spec.")

    try:
        response = await safe_client.request(
            "GET",
            req.spec_url,
            headers={"Accept": "application/json, application/yaml, text/yaml, */*"},
            timeout=_SPEC_TIMEOUT_SECONDS,
            max_bytes=_MAX_SPEC_BYTES,
        )
    except safe_client.UnsafeRequestError as e:
        logger.warning("OpenAPI preview refused for customer=%s: %s", req.customer_id, e)
        return OpenApiPreviewResponse(ok=False, error=str(e))
    except Exception as e:
        logger.warning("OpenAPI preview fetch failed: %s", e)
        return OpenApiPreviewResponse(
            ok=False, error=f"Could not fetch that URL: {e}"
        )

    if not response.ok:
        return OpenApiPreviewResponse(
            ok=False,
            error=f"The spec URL returned HTTP {response.status_code}.",
        )
    if response.truncated:
        return OpenApiPreviewResponse(
            ok=False,
            error="That document is too large to read as a spec.",
        )

    try:
        spec = _parse_spec_text(response.text)
        info, operations, skipped = operations_from_spec(spec)
    except SpecError as e:
        return OpenApiPreviewResponse(ok=False, error=str(e))
    except Exception:
        logger.exception("OpenAPI preview: parsing failed for %s", req.spec_url)
        return OpenApiPreviewResponse(
            ok=False, error="That spec could not be read. It may use features we do not support yet."
        )

    if not operations:
        return OpenApiPreviewResponse(
            ok=False,
            title=info["title"],
            server_url=info["server_url"],
            skipped=[SkippedOperation(**s) for s in skipped],
            error="No operation in that spec could be turned into a tool.",
        )

    return OpenApiPreviewResponse(
        ok=True,
        title=info["title"],
        server_url=info["server_url"],
        operations=[OpenApiOperation(**op) for op in operations],
        skipped=[SkippedOperation(**s) for s in skipped],
    )


@router.post("/connectors/mcp/discover")
async def discover_mcp(req: McpDiscoverRequest) -> McpDiscoverResponse:
    """Connect to an MCP server and return the tools it offers.

    This is the list the user then APPROVES. Nothing is pinned here — the proxy
    saves the approved manifest — because the point of the two-step flow is that
    a human sees what the agent will be told about before it is bound.
    """
    if not req.customer_id:
        raise HTTPException(status_code=400, detail="customer_id is required")
    if not req.server_url:
        return McpDiscoverResponse(ok=False, error="Enter the MCP server's URL.")

    credentials = {}
    if req.credential_ref:
        try:
            resolved = await asyncio.to_thread(
                resolve_tool_credentials, req.customer_id, {req.credential_ref}
            )
            credentials = resolved.get(req.credential_ref) or {}
        except Exception:
            logger.exception(
                "MCP discover: could not resolve credentials for customer=%s",
                req.customer_id,
            )
            return McpDiscoverResponse(
                ok=False, error="Could not read the stored credentials. Try again."
            )
        if not credentials:
            return McpDiscoverResponse(
                ok=False,
                error=(
                    "No credentials are stored for this connector yet. Save the key "
                    "first, then connect."
                ),
            )

    try:
        headers = render_mapping(req.headers or {}, {}, credentials)
    except TemplateError as e:
        return McpDiscoverResponse(ok=False, error=str(e))

    try:
        safe_client.validate_url(req.server_url)
    except safe_client.UnsafeRequestError as e:
        logger.warning("MCP discover refused for customer=%s: %s", req.customer_id, e)
        return McpDiscoverResponse(ok=False, error=str(e))

    try:
        server_name, tools = await _list_mcp_tools(req.server_url, headers)
    except Exception as e:
        logger.warning(
            "MCP discover failed for %s: %s",
            req.server_url, safe_client.redact(e, (credentials or {}).values()),
        )
        return McpDiscoverResponse(
            ok=False,
            error=(
                "Could not reach that MCP server, or it refused the credentials. "
                "Check the URL and the key."
            ),
        )

    if not tools:
        return McpDiscoverResponse(
            ok=False,
            server_name=server_name,
            error="That server is reachable but offers no tools.",
        )

    return McpDiscoverResponse(
        ok=True, server_name=server_name, tool_count=len(tools), tools=tools
    )


async def _list_mcp_tools(server_url: str, headers: dict):
    """One connection, one tools/list, then close.

    The server's own `instructions` are deliberately ignored: that is a third
    party offering text for our prompt, and it is not going there.
    """
    from mcp import Client
    from mcp.client.streamable_http import (
        create_mcp_http_client,
        streamable_http_client,
    )

    transport = streamable_http_client(
        server_url,
        http_client=create_mcp_http_client(headers=headers or None),
    )
    async with Client(transport, read_timeout_seconds=MCP_TIMEOUT_SECONDS) as client:
        listed = await client.list_tools()
        server_name = ""
        initialize_result = getattr(client, "initialize_result", None)
        server_info = getattr(initialize_result, "server_info", None) if initialize_result else None
        if server_info is not None:
            server_name = getattr(server_info, "name", "") or ""

        tools = []
        for tool in getattr(listed, "tools", []) or []:
            schema = getattr(tool, "input_schema", None) or getattr(tool, "inputSchema", None) or {}
            if not isinstance(schema, dict) or schema.get("type") != "object":
                schema = {"type": "object", "properties": {}}
            tools.append(
                McpDiscoveredTool(
                    name=getattr(tool, "name", "") or "",
                    description=(getattr(tool, "description", "") or "")[:1024],
                    inputSchema=schema,
                )
            )
    return server_name, [t for t in tools if t.name]
