"""Turn an OpenAPI document into declarative tool records.

Most of the integrations anyone actually wants are a REST API with a published
spec, and a spec already contains everything a tool record needs: a name, a
description, typed parameters, a method and a path. So importing one is the
cheapest route from "I want my agent to use this service" to a working tool,
and it needs no developer at all.

What this module does NOT do is as important as what it does. It is a
translator, not an executor: it takes a parsed document and returns records,
touching no network and no storage, so it can be tested exhaustively and reused
by a preview endpoint that must not write anything. Fetching the document is
the caller's job, through the SSRF-hardened client, because the URL comes from
the user.

Three limits are deliberate rather than incidental:

  * only parameters this tier can actually express survive. A spec may describe
    deeply nested request bodies; a tool's arguments are a flat list of scalars
    the model fills in. An operation whose required input cannot be expressed is
    SKIPPED with a reason rather than imported in a broken state,
  * $ref resolution is depth-limited and local-only. A remote $ref would be a
    second fetch to an address the user chose,
  * the operation count is capped. A 200-operation spec is not a tool list, it
    is a context-window problem, so the caller is told what was left out.

An operation that survives is still only a DRAFT. It earns `active` the same way
a hand-written tool does, by a dry run that proves it.
"""
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

MAX_OPERATIONS = 200
MAX_PARAMETERS_PER_OPERATION = 20
MAX_REF_DEPTH = 8
MAX_DESCRIPTION_CHARS = 1024
MIN_DESCRIPTION_CHARS = 10

# Methods the http tier can execute, in the order a spec usually lists them.
SUPPORTED_METHODS = ("get", "post", "put", "patch", "delete")

# JSON Schema types a tool argument may have. Anything else (object, array,
# null) cannot be rendered into a flat form for the model to fill in.
SCALAR_TYPES = {"string", "number", "integer", "boolean"}

_NAME_CLEAN = re.compile(r"[^a-z0-9_]+")
_NAME_VALID = re.compile(r"^[a-z][a-z0-9_]{2,63}$")


class SpecError(ValueError):
    """The document is not a usable OpenAPI spec."""


def _slug(text: str) -> str:
    """A tool-name-safe slug: lowercase, underscore-separated."""
    out = _NAME_CLEAN.sub("_", (text or "").strip().lower()).strip("_")
    return re.sub(r"_+", "_", out)


def tool_name_for(operation_id: str, method: str, path: str) -> str:
    """A stable, legal tool name for one operation.

    Prefers the spec's own operationId, because that is what the API's own docs
    call it and the model will have seen it. Falls back to method-plus-path,
    which is ugly but unambiguous.
    """
    candidate = _slug(operation_id)
    if not _NAME_VALID.match(candidate):
        # e.g. GET /v1/issues/{id} -> get_v1_issues_id
        path_part = _slug(path.replace("{", "").replace("}", ""))
        candidate = _slug(f"{method}_{path_part}")
    if not candidate or candidate[0].isdigit():
        candidate = f"op_{candidate}"
    candidate = candidate[:64]
    while candidate and not _NAME_VALID.match(candidate):
        # Trim trailing underscores or an over-short name into legality.
        if len(candidate) < 3:
            candidate = (candidate + "_op")[:64]
        else:
            candidate = candidate.rstrip("_")
            if not candidate:
                return "operation"
            if not _NAME_VALID.match(candidate):
                candidate = "op_" + candidate.lstrip("_")
                candidate = candidate[:64].rstrip("_")
                break
    return candidate if _NAME_VALID.match(candidate) else "operation"


def _resolve_ref(spec: dict, ref: str, depth: int) -> dict:
    """Resolve a local #/... reference. Remote refs are refused: following one
    would be a fetch to an address the user chose."""
    if depth > MAX_REF_DEPTH:
        raise SpecError("$ref nesting is too deep")
    if not ref.startswith("#/"):
        raise SpecError(f"Only local $ref is supported, got '{ref}'")
    node: Any = spec
    for part in ref[2:].split("/"):
        part = part.replace("~1", "/").replace("~0", "~")
        if not isinstance(node, dict) or part not in node:
            raise SpecError(f"$ref '{ref}' does not resolve")
        node = node[part]
    if not isinstance(node, dict):
        raise SpecError(f"$ref '{ref}' does not point at an object")
    return node


def _deref(spec: dict, node: Any, depth: int = 0) -> Any:
    """Follow $ref one level at a time, bounded."""
    seen = 0
    while isinstance(node, dict) and "$ref" in node:
        node = _resolve_ref(spec, node["$ref"], depth + seen)
        seen += 1
        if seen > MAX_REF_DEPTH:
            raise SpecError("$ref chain is too long")
    return node


def _server_url(spec: dict) -> str:
    """The base URL every path is relative to."""
    servers = spec.get("servers")
    if isinstance(servers, list) and servers:
        first = servers[0]
        if isinstance(first, dict):
            url = (first.get("url") or "").strip()
            if url:
                return url.rstrip("/")
    # Swagger 2.0
    host = (spec.get("host") or "").strip()
    if host:
        scheme = "https"
        schemes = spec.get("schemes")
        if isinstance(schemes, list) and schemes and "https" not in schemes:
            scheme = schemes[0]
        base = (spec.get("basePath") or "").rstrip("/")
        return f"{scheme}://{host}{base}"
    raise SpecError(
        "The spec does not say which server to call. Add a servers entry, or "
        "define the tool by hand with the base URL."
    )


def _property_schema(schema: dict, description: str) -> dict | None:
    """A tool-argument property from a spec schema, or None when the type
    cannot be expressed as a flat scalar the model fills in."""
    schema_type = schema.get("type")
    if isinstance(schema_type, list):
        schema_type = next((t for t in schema_type if t in SCALAR_TYPES), None)
    if schema_type not in SCALAR_TYPES:
        return None
    prop: dict = {"type": schema_type}
    text = (description or schema.get("description") or "").strip()
    if text:
        prop["description"] = text[:300]
    enum = schema.get("enum")
    if isinstance(enum, list) and enum and all(isinstance(v, (str, int, float)) for v in enum):
        prop["enum"] = enum[:20]
    return prop


def _collect_parameters(spec: dict, operation: dict, path_item: dict):
    """(properties, required, path_params, query_params, header_params, warnings)."""
    properties: dict[str, dict] = {}
    required: list[str] = []
    in_path: dict[str, str] = {}
    in_query: dict[str, str] = {}
    in_header: dict[str, str] = {}
    warnings: list[str] = []

    # Path-level parameters apply to every operation under that path.
    raw = list(path_item.get("parameters") or []) + list(operation.get("parameters") or [])
    for entry in raw:
        entry = _deref(spec, entry)
        if not isinstance(entry, dict):
            continue
        name = (entry.get("name") or "").strip()
        location = entry.get("in")
        if not name or location not in ("path", "query", "header"):
            if location in ("cookie", "formData"):
                warnings.append(f"parameter '{name}' in {location} was skipped")
            continue
        schema = _deref(spec, entry.get("schema") or entry) or {}
        prop = _property_schema(schema if isinstance(schema, dict) else {}, entry.get("description", ""))
        if prop is None:
            warnings.append(
                f"parameter '{name}' has a type this tool format cannot express and was skipped"
            )
            continue
        key = _slug(name) or name
        if key in properties:
            continue
        properties[key] = prop
        if entry.get("required") or location == "path":
            required.append(key)
        if location == "path":
            in_path[name] = key
        elif location == "query":
            in_query[name] = key
        else:
            in_header[name] = key
    return properties, required, in_path, in_query, in_header, warnings


def _collect_body(spec: dict, operation: dict):
    """(body_template, properties, required, warnings) for a JSON request body.

    Only a flat object of scalars is importable. A nested body is reported
    rather than silently flattened, because a half-built request would fail at
    call time with nothing explaining why.
    """
    properties: dict[str, dict] = {}
    required: list[str] = []
    body: dict[str, str] = {}
    warnings: list[str] = []

    request_body = _deref(spec, operation.get("requestBody"))
    if not isinstance(request_body, dict):
        return None, properties, required, warnings

    content = request_body.get("content")
    if not isinstance(content, dict):
        return None, properties, required, warnings
    json_media = next(
        (v for k, v in content.items() if "json" in str(k).lower()), None
    )
    if not isinstance(json_media, dict):
        warnings.append("the request body is not JSON and was skipped")
        return None, properties, required, warnings

    schema = _deref(spec, json_media.get("schema")) or {}
    if not isinstance(schema, dict) or schema.get("type") not in (None, "object"):
        warnings.append("the request body is not an object and was skipped")
        return None, properties, required, warnings

    body_required = set(schema.get("required") or [])
    for name, raw_prop in (schema.get("properties") or {}).items():
        resolved = _deref(spec, raw_prop)
        if not isinstance(resolved, dict):
            continue
        prop = _property_schema(resolved, resolved.get("description", ""))
        key = _slug(name) or name
        if prop is None:
            if name in body_required:
                # A required field we cannot express means the call would fail.
                raise _Unimportable(
                    f"required body field '{name}' has a type this tool format "
                    "cannot express"
                )
            warnings.append(f"body field '{name}' was skipped (unsupported type)")
            continue
        if key in properties:
            continue
        properties[key] = prop
        body[name] = f"{{{{args.{key}}}}}"
        if name in body_required:
            required.append(key)
    return (body or None), properties, required, warnings


class _Unimportable(Exception):
    """This operation cannot be represented; skip it with a reason."""


def _description_for(operation: dict, method: str, path: str) -> str:
    text = (operation.get("summary") or "").strip()
    detail = (operation.get("description") or "").strip()
    if detail and detail != text:
        text = f"{text}. {detail}".strip(". ").strip() if text else detail
    if not text:
        text = f"Call {method.upper()} {path} on this API."
    text = re.sub(r"\s+", " ", text)
    if len(text) < MIN_DESCRIPTION_CHARS:
        text = f"{text} Calls {method.upper()} {path}."
    return text[:MAX_DESCRIPTION_CHARS]


def operations_from_spec(spec: dict) -> tuple[dict, list[dict], list[dict]]:
    """Parse a spec into (info, operations, skipped).

    `operations` are ready-to-save tool records apart from `credentialRef`,
    which the caller supplies. `skipped` explains, per operation, why it could
    not be imported — that list is shown to the user, so the reasons are
    written for them rather than for a log.
    """
    if not isinstance(spec, dict):
        raise SpecError("The spec is not a JSON object.")
    if not (spec.get("openapi") or spec.get("swagger")):
        raise SpecError(
            "This does not look like an OpenAPI or Swagger document (no openapi "
            "or swagger version field)."
        )
    paths = spec.get("paths")
    if not isinstance(paths, dict) or not paths:
        raise SpecError("The spec defines no paths.")

    server_url = _server_url(spec)
    info = {
        "title": ((spec.get("info") or {}).get("title") or "API").strip(),
        "server_url": server_url,
    }

    operations: list[dict] = []
    skipped: list[dict] = []
    used_names: set[str] = set()
    seen = 0

    for path, path_item in paths.items():
        if not isinstance(path_item, dict):
            continue
        for method in SUPPORTED_METHODS:
            operation = path_item.get(method)
            if not isinstance(operation, dict):
                continue
            seen += 1
            if len(operations) >= MAX_OPERATIONS:
                skipped.append({
                    "operationId": operation.get("operationId") or f"{method} {path}",
                    "reason": f"only the first {MAX_OPERATIONS} operations are imported",
                })
                continue
            if operation.get("deprecated"):
                skipped.append({
                    "operationId": operation.get("operationId") or f"{method} {path}",
                    "reason": "the spec marks this operation deprecated",
                })
                continue
            try:
                record = _operation_record(
                    spec, path, path_item, method, operation, server_url, used_names
                )
            except _Unimportable as e:
                skipped.append({
                    "operationId": operation.get("operationId") or f"{method} {path}",
                    "reason": str(e),
                })
                continue
            except SpecError as e:
                skipped.append({
                    "operationId": operation.get("operationId") or f"{method} {path}",
                    "reason": str(e),
                })
                continue
            operations.append(record)
            used_names.add(record["name"])

    logger.info(
        "OpenAPI import: %d operation(s) importable, %d skipped, of %d seen",
        len(operations), len(skipped), seen,
    )
    return info, operations, skipped


def _operation_record(
    spec: dict,
    path: str,
    path_item: dict,
    method: str,
    operation: dict,
    server_url: str,
    used_names: set[str],
) -> dict:
    props, required, in_path, in_query, in_header, warnings = _collect_parameters(
        spec, operation, path_item
    )
    body_template, body_props, body_required, body_warnings = _collect_body(spec, operation)
    warnings = warnings + body_warnings

    for key, prop in body_props.items():
        if key not in props:
            props[key] = prop
    required = list(dict.fromkeys(required + body_required))

    if len(props) > MAX_PARAMETERS_PER_OPERATION:
        raise _Unimportable(
            f"it takes {len(props)} arguments, more than the {MAX_PARAMETERS_PER_OPERATION} "
            "a single tool can usefully expose"
        )

    # A path parameter the spec never declared would leave a literal {id} in the
    # URL, which is a tool that fails at call time with nothing explaining why.
    # Checked BEFORE substitution, against the original path: afterwards the
    # inserted {{args.x}} placeholders contain braces of their own.
    templated = set(re.findall(r"\{([^{}]+)\}", path))
    leftover = sorted(templated - set(in_path))
    if leftover:
        raise _Unimportable(
            f"the path needs {', '.join(leftover)}, which the spec does not declare "
            "as parameters"
        )
    url_path = path
    for raw_name, key in in_path.items():
        url_path = url_path.replace("{" + raw_name + "}", f"{{{{args.{key}}}}}")

    name = tool_name_for(operation.get("operationId") or "", method, path)
    if name in used_names:
        suffix = 2
        while f"{name}_{suffix}"[:64] in used_names:
            suffix += 1
        name = f"{name}_{suffix}"[:64]

    request: dict = {
        "method": method.upper(),
        "url": f"{server_url}{url_path}",
        "headers": {h: f"{{{{args.{k}}}}}" for h, k in in_header.items()},
        "query": {q: f"{{{{args.{k}}}}}" for q, k in in_query.items()},
        "body": body_template,
        "bodyType": "json",
    }

    return {
        "name": name,
        "description": _description_for(operation, method, path),
        "parameters": {
            "type": "object",
            "properties": props,
            "required": required,
        },
        "provider": "http",
        "request": request,
        "responseTransform": {"mode": "json", "maxChars": 8000},
        "method": method.upper(),
        "path": path,
        "warnings": warnings,
    }
