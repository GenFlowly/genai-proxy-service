"""Placeholder rendering for declarative HTTP tools.

A stored tool describes its request with two placeholder namespaces:

    {{args.<key>}}        a value the MODEL supplied for this call
    {{credential.<key>}}  a value from the customer's decrypted credential blob

Everything here exists because `args` values are model-controlled and therefore
attacker-influenceable: a user can paste text into a chat that steers the model
into calling a tool with hostile arguments. The rules that follow are what keep
that from becoming a request to somewhere else:

  * placeholders are substituted, never evaluated — there is no expression
    language, no attribute traversal, no recursion into the substituted value,
  * a placeholder naming an unknown key is an error, never an empty string,
    so a typo cannot silently produce `Bearer ` or a truncated URL,
  * values substituted into a URL PATH are percent-encoded with an empty safe
    set, so `/`, `?`, `#`, and `..` cannot escape the segment they are in,
  * the scheme and host are never templated at all (see http_tool.pin_origin).
"""
import re
from typing import Any
from urllib.parse import quote

# {{ns.key}} with optional inner whitespace. Keys are conservative on purpose:
# anything outside this alphabet is a malformed template, not a lookup.
_PLACEHOLDER = re.compile(r"\{\{\s*(args|credential)\.([A-Za-z0-9_]+)\s*\}\}")

# A '{{' that _PLACEHOLDER did not match — i.e. a malformed or unknown-namespace
# placeholder. Detected explicitly so it cannot survive into an outbound request
# as a literal.
_ANY_OPEN = re.compile(r"\{\{")


class TemplateError(ValueError):
    """A template could not be rendered. Surfaced to the model as tool output,
    never raised past the executor."""


def placeholders(template: str) -> set[tuple[str, str]]:
    """Every (namespace, key) the template references."""
    return {(m.group(1), m.group(2)) for m in _PLACEHOLDER.finditer(template or "")}


def arg_names(template: str) -> set[str]:
    return {key for ns, key in placeholders(template) if ns == "args"}


def has_placeholder(template: str) -> bool:
    return bool(_ANY_OPEN.search(template or ""))


def _lookup(namespace: str, key: str, args: dict, credentials: dict) -> Any:
    source = args if namespace == "args" else credentials
    if key not in source:
        # Deliberately does not say which credential keys exist.
        where = "call arguments" if namespace == "args" else "stored credentials"
        raise TemplateError(f"'{namespace}.{key}' is not present in the {where}")
    value = source[key]
    if value is None:
        raise TemplateError(f"'{namespace}.{key}' is empty")
    return value


def _stringify(value: Any) -> str:
    if isinstance(value, bool):
        # json/HTTP convention rather than Python's True/False.
        return "true" if value else "false"
    return str(value)


def render(
    template: str,
    args: dict,
    credentials: dict,
    *,
    encode: bool = False,
) -> str:
    """Substitute placeholders in `template`.

    encode=True percent-encodes each substituted value with an empty safe set,
    for use inside a URL path. The literal parts of the template are never
    encoded — the author wrote those.
    """
    if template is None:
        return ""
    if not isinstance(template, str):
        raise TemplateError(f"Expected a string template, got {type(template).__name__}")

    def replace(match: re.Match) -> str:
        raw = _stringify(_lookup(match.group(1), match.group(2), args, credentials))
        return quote(raw, safe="") if encode else raw

    rendered = _PLACEHOLDER.sub(replace, template)
    if has_placeholder(rendered):
        # Either a malformed placeholder, an unknown namespace, or a value that
        # itself contained '{{'. None of those may reach the wire: the first two
        # are author errors and the third would be a second substitution pass.
        raise TemplateError(
            "Template still contains an unresolved placeholder after rendering — "
            "check for a malformed {{...}} or a value containing '{{'"
        )
    return rendered


def render_mapping(
    mapping: dict | None,
    args: dict,
    credentials: dict,
) -> dict[str, str]:
    """Render a flat {name: template} map, e.g. headers or query parameters.

    Keys are literal — templating a header NAME would let a model-controlled
    value introduce an arbitrary header.
    """
    if not mapping:
        return {}
    out: dict[str, str] = {}
    for key, value in mapping.items():
        if not isinstance(key, str):
            raise TemplateError("Header and query names must be strings")
        if has_placeholder(key):
            raise TemplateError(f"'{key}' is not a valid name — names cannot be templated")
        out[key] = render(value, args, credentials)
    return out


def render_body(body: Any, args: dict, credentials: dict) -> Any:
    """Render a JSON body, preserving non-string leaf types.

    A string leaf that is EXACTLY one placeholder adopts the value's own type,
    so a numeric argument stays a number in the JSON body rather than becoming
    a string an API would reject. A string with surrounding literal text is
    always rendered as a string.
    """
    if body is None:
        return None
    if isinstance(body, str):
        match = _PLACEHOLDER.fullmatch(body.strip())
        if match:
            return _lookup(match.group(1), match.group(2), args, credentials)
        return render(body, args, credentials)
    if isinstance(body, dict):
        rendered = {}
        for key, value in body.items():
            if not isinstance(key, str):
                raise TemplateError("JSON body keys must be strings")
            if has_placeholder(key):
                raise TemplateError(f"'{key}' is not a valid body key — keys cannot be templated")
            rendered[key] = render_body(value, args, credentials)
        return rendered
    if isinstance(body, list):
        return [render_body(item, args, credentials) for item in body]
    # numbers, booleans, null pass through untouched
    return body
