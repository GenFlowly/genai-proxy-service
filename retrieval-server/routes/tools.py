"""Dry-run endpoint for declarative tools.

A customer-defined tool is a template plus a credential, and the most common
way it goes wrong is silently: it returns 200 with a body that means nothing to
the model, and the agent starts quietly answering from garbage. A dry run is
the gate that catches that before the tool is ever bound, which is why a tool
stays in `draft` until one succeeds.

The response deliberately shows three things, because each catches a different
mistake:

  request     what would actually go out, with credential values MASKED —
              catches a wrong header name, a missing argument, a bad path
  response    the raw upstream reply, truncated — catches auth and shape errors
  model_sees  the exact string the model would receive — catches the silent
              failure above, where the call works but the transform yields
              nothing useful

The tool definition is supplied in the request body rather than read from
DynamoDB, so a draft can be tested before it is saved. Credentials are never
accepted from the caller: they are resolved here from the customer's stored
blob, exactly as they are during a real run.
"""
import asyncio
import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from graph.tool_credentials import resolve_tool_credentials
from graph_tools.providers import safe_client
from graph_tools.providers.http_tool import HttpTool, ToolDefinitionError
from graph_tools.providers.template import TemplateError

logger = logging.getLogger(__name__)

router = APIRouter()

# What a credential value is replaced with in the echoed request. Long enough
# to be obviously a mask, not derived from the real value's length.
_MASK = "••••••••"

_MAX_ECHOED_BODY_CHARS = 4000


class DryRunRequest(BaseModel):
    customer_id: str
    # The tool record, in the same shape the CustomerTools table stores. Passed
    # in rather than loaded so an unsaved draft can be tested.
    tool: dict
    args: dict = Field(default_factory=dict)


class DryRunPreparedRequest(BaseModel):
    method: str
    url: str
    headers: dict = Field(default_factory=dict)
    query: dict = Field(default_factory=dict)
    body: object | None = None


class DryRunUpstreamResponse(BaseModel):
    status_code: int
    body: str
    truncated: bool = False


class DryRunResponse(BaseModel):
    ok: bool
    # Present whenever the request could be rendered, even if the call failed.
    request: DryRunPreparedRequest | None = None
    response: DryRunUpstreamResponse | None = None
    # The exact string the model would receive as this tool's result.
    model_sees: str | None = None
    error: str | None = None


def _masked_credentials(credentials: dict) -> dict:
    """Same keys, masked values — so rendering with these produces a request
    identical to the real one except where a secret would appear. Masking by
    re-rendering avoids searching the outbound request for secret substrings,
    which misses any value the template transformed."""
    return {key: _MASK for key in (credentials or {})}


@router.post("/tools/dry-run")
async def dry_run(req: DryRunRequest) -> DryRunResponse:
    if not req.customer_id:
        raise HTTPException(status_code=400, detail="customer_id is required")

    try:
        tool = HttpTool(req.tool or {})
    except ToolDefinitionError as e:
        # A definition problem, not a run problem: report it as a normal result
        # so the UI can show it inline on the form.
        return DryRunResponse(ok=False, error=str(e))

    credentials = {}
    if tool.credential_ref:
        try:
            resolved = await asyncio.to_thread(
                resolve_tool_credentials, req.customer_id, {tool.credential_ref}
            )
            credentials = resolved.get(tool.credential_ref) or {}
        except Exception:
            logger.exception(
                "Dry run: could not resolve credentials for customer=%s ref=%s",
                req.customer_id, tool.credential_ref,
            )
            return DryRunResponse(
                ok=False,
                error="Could not read the stored credentials for this tool. Try again.",
            )
        if not credentials:
            return DryRunResponse(
                ok=False,
                error=(
                    f"No credentials are stored for '{tool.credential_ref}'. "
                    "Connect the tool's key first, then run this again."
                ),
            )

    # Render twice: once for the wire, once for display. The masked render is
    # what the caller sees, so a secret cannot reach the UI or its logs.
    try:
        prepared = tool.build_request(req.args or {}, credentials)
        display = tool.build_request(req.args or {}, _masked_credentials(credentials))
    except (TemplateError, ToolDefinitionError) as e:
        return DryRunResponse(ok=False, error=str(e))

    echoed = DryRunPreparedRequest(
        method=display["method"],
        url=display["url"],
        headers=display["headers"],
        query=display["query"],
        body=display["body"],
    )

    try:
        response = await safe_client.request(
            prepared["method"],
            prepared["url"],
            headers=prepared["headers"],
            params=prepared["query"] or None,
            json_body=prepared["body"] if tool.body_type == "json" else None,
            form_body=prepared["body"] if tool.body_type == "form" else None,
        )
    except safe_client.UnsafeRequestError as e:
        return DryRunResponse(ok=False, request=echoed, error=str(e))
    except Exception as e:
        logger.warning("Dry run: request to %s failed — %s", tool.origin, e)
        return DryRunResponse(
            ok=False, request=echoed, error=f"Could not reach {tool.origin}: {e}"
        )

    body = response.text[:_MAX_ECHOED_BODY_CHARS]
    upstream = DryRunUpstreamResponse(
        status_code=response.status_code,
        body=body,
        truncated=response.truncated or len(response.text) > len(body),
    )

    return DryRunResponse(
        ok=response.ok,
        request=echoed,
        response=upstream,
        model_sees=tool.transform_response(response),
        error=None if response.ok else f"Upstream returned HTTP {response.status_code}",
    )
