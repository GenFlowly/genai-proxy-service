"""HttpTool: one generic GraphTool that executes a stored request template.

A customer's tool is a RECORD, not code. This class is the interpreter for that
record, so adding a tool costs a row rather than a deploy. The record holds no
secret: the credential is named by reference and resolved per request by the
host, arriving through `context.secrets`.

The record shape is fixed by the Phase 1 contract:

    {
      "name": "create_linear_issue",
      "description": "Create an issue in Linear...",
      "parameters": {"type": "object", "properties": {...}, "required": [...]},
      "request": {"method": "POST", "url": "https://api.linear.app/...",
                  "headers": {...}, "query": {...}, "body": {...},
                  "bodyType": "json"},
      "credentialRef": "LINEAR",
      "responseTransform": {"mode": "json_path", "path": "data.id"}
    }

The destination host is pinned when the tool is DEFINED. `{{args.*}}` may
appear in the path, query, headers and body, never in the scheme or host, and
the resolved URL's origin is re-checked before the call. That is what makes it
structurally impossible for a prompt-injected argument to point this somewhere
else — the strongest property this tier has, so it is enforced in two places
rather than one.
"""
import json
import logging
from urllib.parse import urlsplit, urlunsplit

from graph_tools.base import GraphTool, ToolContext, ToolResult
from graph_tools.providers import safe_client, template
from graph_tools.providers.template import TemplateError

logger = logging.getLogger(__name__)

DEFAULT_MAX_CHARS = 8000
MAX_MAX_CHARS = 32000

_ALLOWED_BODY_TYPES = frozenset({"json", "form"})


class ToolDefinitionError(ValueError):
    """The stored record is not a usable tool definition."""


def pin_origin(url_template: str) -> tuple[str, str]:
    """Split a URL template into its literal origin and its templated remainder.

    Raises when the scheme or host contains a placeholder: those must be fixed
    at definition time so no runtime value can move the request.
    """
    if not url_template or not isinstance(url_template, str):
        raise ToolDefinitionError("request.url is required")
    parts = urlsplit(url_template)
    if parts.scheme != "https":
        raise ToolDefinitionError("request.url must be an https URL")
    if not parts.netloc:
        raise ToolDefinitionError("request.url must include a host")
    if template.has_placeholder(parts.scheme) or template.has_placeholder(parts.netloc):
        raise ToolDefinitionError(
            "request.url may not template its scheme or host — the destination "
            "is fixed when the tool is defined"
        )
    origin = urlunsplit((parts.scheme, parts.netloc, "", "", ""))
    remainder = urlunsplit(("", "", parts.path, parts.query, ""))
    return origin, remainder


def _validate_parameters(parameters) -> dict:
    if not isinstance(parameters, dict) or parameters.get("type") != "object":
        raise ToolDefinitionError("parameters must be a JSON Schema object")
    properties = parameters.get("properties")
    if not isinstance(properties, dict):
        raise ToolDefinitionError("parameters.properties must be an object")
    return parameters


def as_dict(value, field: str) -> dict:
    """Records arrive with JSON-encoded attributes from DynamoDB, or already
    decoded from an API payload. Accept both."""
    if value is None or value == "":
        return {}
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as e:
            raise ToolDefinitionError(f"{field} is not valid JSON") from e
    if not isinstance(value, dict):
        raise ToolDefinitionError(f"{field} must be an object")
    return value


def _truncate(text: str, limit: int) -> tuple[str, bool]:
    if len(text) <= limit:
        return text, False
    return text[:limit], True


def _walk_path(data, path: str):
    """Resolve a dotted path. Integer segments index into lists."""
    current = data
    for segment in path.split("."):
        if segment == "":
            continue
        if isinstance(current, list):
            try:
                current = current[int(segment)]
            except (ValueError, IndexError):
                return None
        elif isinstance(current, dict):
            if segment not in current:
                return None
            current = current[segment]
        else:
            return None
    return current


class HttpTool(GraphTool):
    """A customer-defined tool backed by a single HTTP request."""

    def __init__(self, record: dict):
        name = (record.get("name") or "").strip()
        if not name:
            raise ToolDefinitionError("name is required")
        description = (record.get("description") or "").strip()
        if not description:
            raise ToolDefinitionError(f"Tool '{name}' has no description")

        self.name = name
        self.description = description
        self.parameters = _validate_parameters(as_dict(record.get("parameters"), "parameters"))
        self.credential_ref = (record.get("credentialRef") or "").strip() or None

        request = as_dict(record.get("request"), "request")
        self.method = (request.get("method") or "GET").upper()
        if self.method not in safe_client.ALLOWED_METHODS:
            raise ToolDefinitionError(
                f"Tool '{name}' uses method '{self.method}', which is not allowed"
            )
        self.origin, self.path_template = pin_origin(request.get("url"))
        self.header_templates = request.get("headers") or {}
        self.query_templates = request.get("query") or {}
        self.body_template = request.get("body")
        self.body_type = (request.get("bodyType") or "json").lower()
        if self.body_type not in _ALLOWED_BODY_TYPES:
            raise ToolDefinitionError(
                f"Tool '{name}' has bodyType '{self.body_type}', expected json or form"
            )

        transform = as_dict(record.get("responseTransform"), "responseTransform")
        self.response_mode = (transform.get("mode") or "text").lower()
        if self.response_mode not in ("text", "json", "json_path"):
            raise ToolDefinitionError(
                f"Tool '{name}' has responseTransform.mode '{self.response_mode}'"
            )
        self.response_path = transform.get("path") or ""
        if self.response_mode == "json_path" and not self.response_path:
            raise ToolDefinitionError(
                f"Tool '{name}' uses json_path but sets no path"
            )
        try:
            self.max_chars = int(transform.get("maxChars") or DEFAULT_MAX_CHARS)
        except (TypeError, ValueError):
            self.max_chars = DEFAULT_MAX_CHARS
        self.max_chars = max(100, min(self.max_chars, MAX_MAX_CHARS))

        self._verify_argument_references()

    def _verify_argument_references(self) -> None:
        """Every {{args.x}} must name a declared parameter, so a definition
        cannot depend on an argument the model is never told about."""
        declared = set(self.parameters.get("properties", {}))
        referenced: set[str] = set()
        for text in [self.path_template, *self.header_templates.values(),
                     *self.query_templates.values()]:
            if isinstance(text, str):
                referenced |= template.arg_names(text)
        referenced |= self._body_arg_names(self.body_template)
        unknown = sorted(referenced - declared)
        if unknown:
            raise ToolDefinitionError(
                f"Tool '{self.name}' references undeclared argument(s): {', '.join(unknown)}"
            )

    def _body_arg_names(self, body) -> set[str]:
        if isinstance(body, str):
            return template.arg_names(body)
        if isinstance(body, dict):
            names: set[str] = set()
            for value in body.values():
                names |= self._body_arg_names(value)
            return names
        if isinstance(body, list):
            names = set()
            for item in body:
                names |= self._body_arg_names(item)
            return names
        return set()

    def build_request(self, args: dict, credentials: dict) -> dict:
        """Render the template into a concrete request.

        Separated from `run` so a dry run can show the caller exactly what would
        be sent without sending it.
        """
        # Path values are percent-encoded so an argument cannot escape its
        # segment; header, query and body values are not (their transports
        # encode them).
        path = template.render(self.path_template, args, credentials, encode=True)
        url = self.origin + (path if path.startswith("/") or not path else "/" + path)

        # Belt and braces: the origin is literal by construction, but re-check
        # the assembled URL so any future change to path rendering cannot
        # quietly move the destination.
        assembled = urlsplit(url)
        if urlunsplit((assembled.scheme, assembled.netloc, "", "", "")) != self.origin:
            raise TemplateError(
                "Rendered URL does not match the tool's pinned destination"
            )

        return {
            "method": self.method,
            "url": url,
            "headers": template.render_mapping(self.header_templates, args, credentials),
            "query": template.render_mapping(self.query_templates, args, credentials),
            "body": template.render_body(self.body_template, args, credentials),
            "bodyType": self.body_type,
        }

    def transform_response(self, response: safe_client.HttpResponse) -> str:
        """Turn the HTTP response into the string the model will read."""
        if self.response_mode == "text":
            text, cut = _truncate(response.text, self.max_chars)
            return text + ("\n\n[truncated]" if cut or response.truncated else "")

        try:
            data = json.loads(response.text) if response.text.strip() else None
        except json.JSONDecodeError:
            text, cut = _truncate(response.text, self.max_chars)
            return (
                "The response was not valid JSON. Raw body:\n"
                + text + ("\n\n[truncated]" if cut else "")
            )

        if self.response_mode == "json_path":
            value = _walk_path(data, self.response_path)
            if value is None:
                return (
                    f"The response did not contain '{self.response_path}'. "
                    "The call succeeded but returned nothing at that location."
                )
            data = value

        rendered = data if isinstance(data, str) else json.dumps(data, indent=2, default=str)
        text, cut = _truncate(rendered, self.max_chars)
        return text + ("\n\n[truncated]" if cut or response.truncated else "")

    async def run(self, args: dict, context: ToolContext) -> ToolResult:
        credentials = context.secrets(self.credential_ref) if self.credential_ref else {}
        if self.credential_ref and not credentials:
            return ToolResult(content=(
                f"'{self.name}' is not connected yet — no credentials are stored for it. "
                "Tell the user to connect it in Settings, then try again."
            ))

        try:
            prepared = self.build_request(args or {}, credentials or {})
        except (TemplateError, ToolDefinitionError) as e:
            # An author or argument problem. The model can often fix it by
            # calling again with different arguments, so say what was wrong.
            return ToolResult(content=f"Could not build the request for '{self.name}': {e}")

        logger.info(
            "HttpTool %s: customer=%s %s %s",
            self.name, context.customer_id, prepared["method"], self.origin,
        )
        try:
            response = await safe_client.request(
                prepared["method"],
                prepared["url"],
                headers=prepared["headers"],
                params=prepared["query"] or None,
                json_body=prepared["body"] if self.body_type == "json" else None,
                form_body=prepared["body"] if self.body_type == "form" else None,
            )
        except safe_client.UnsafeRequestError as e:
            logger.warning("HttpTool %s: refused — %s", self.name, e)
            return ToolResult(content=f"'{self.name}' could not be called: {e}")
        except Exception as e:
            # An upstream error can quote the credential back at us.
            logger.error(
                "HttpTool %s: request failed — %s",
                self.name, safe_client.redact(e, (credentials or {}).values()),
            )
            return ToolResult(content=(
                f"'{self.name}' failed to reach {self.origin}. "
                "Try again, or answer without it and say the call did not go through."
            ))

        if not response.ok:
            body, _ = _truncate(response.text, 1000)
            return ToolResult(content=(
                f"'{self.name}' returned HTTP {response.status_code}.\n{body}"
            ))

        return ToolResult(content=self.transform_response(response))
