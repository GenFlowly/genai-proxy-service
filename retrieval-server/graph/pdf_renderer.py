"""Which PDF renderer a request uses (plan 2.1).

Three environment values, read when a turn starts:

- PDF_RENDERER: the default renderer, 'x2p_v1' unless set;
- PDF_RENDERER_CANARY, applied to the customers listed (comma-separated) in
  PDF_RENDERER_CANARY_CUSTOMERS;
- PDF_RENDERER_SCRIPT_ROUTE: unset by default. When 'typst', a document
  whose letters x2p_v1 cannot draw (pdf_charsets.find_undrawable) renders
  with Typst for every tenant, provided the bundled fonts cover them; any
  other document stays on x2p_v1 with the 1.14 note.

Valid renderers are 'x2p_v1' and 'typst'. Unknown values, and 'typst' in a
build without the Typst library or its fonts, fall back to the default with a
WARNING (never document content). There is deliberately no graph node-config
override: node config is customer-editable, and the renderer is an internal
engine choice.

The base renderer and the script-route setting are resolved ONCE per turn,
before the run starts (the /retrieve handler, POST /runs before enqueue), and
carried as declared request/state fields, so a durable run recovered after an
env flip keeps the renderer it started with. Only the per-document route
decision is made at render time, from the content (generate_pdf).

Flipping any of these values changes Fly env, which restarts the single
production machine (a health-gated restart followed by DBOS recovery of
in-flight runs). A runtime-changeable store is deferred.
"""
import functools
import importlib.util
import logging
import os

logger = logging.getLogger(__name__)

RENDERERS = ("x2p_v1", "typst")
DEFAULT_RENDERER = "x2p_v1"
SCRIPT_ROUTES = ("typst",)


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


@functools.lru_cache(maxsize=1)
def typst_available() -> bool:
    """Whether this build can render with Typst: the typst package and the
    pdf_typst module are importable (checked without importing either) and
    the bundled fonts are present."""
    try:
        if importlib.util.find_spec("typst") is None:
            return False
        if importlib.util.find_spec("graph_tools.tools.pdf_typst") is None:
            return False
    except (ImportError, ValueError):
        return False
    fonts = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "graph_tools", "fonts"
    )
    try:
        return any(name.lower().endswith((".ttf", ".otf")) for name in os.listdir(fonts))
    except OSError:
        return False


@functools.lru_cache(maxsize=1)
def x2p_available() -> bool:
    """Whether this build still ships the bridge renderer (5.2 removes it)."""
    try:
        return importlib.util.find_spec("xhtml2pdf") is not None
    except (ImportError, ValueError):
        return False


def _installed(renderer: str) -> str:
    """`renderer`, or Typst when x2p_v1 was removed from this build (plan 5.2:
    a durable run pinned to x2p_v1 and recovered after the removal deploy
    renders with Typst instead of failing)."""
    if renderer == "x2p_v1" and not x2p_available() and typst_available():
        return "typst"
    return renderer


def _usable(value: str, source: str) -> str | None:
    """`value` if it names a renderer this build can run, else None (logged)."""
    if not value:
        return None
    if value not in RENDERERS:
        logger.warning("Unknown PDF renderer in %s; using %s", source, DEFAULT_RENDERER)
        return None
    if value == "typst" and not typst_available():
        logger.warning("PDF renderer typst from %s is not available in this build; using %s",
                       source, DEFAULT_RENDERER)
        return None
    return value


def _canary_customers() -> set[str]:
    return {c.strip() for c in _env("PDF_RENDERER_CANARY_CUSTOMERS").split(",") if c.strip()}


def base_renderer(customer_id: str | None) -> str:
    """The request's renderer before any per-document route: the canary
    value for listed customers, else PDF_RENDERER, else the default."""
    renderer = _usable(_env("PDF_RENDERER"), "PDF_RENDERER") or DEFAULT_RENDERER
    canary = _env("PDF_RENDERER_CANARY")
    if canary and customer_id and customer_id in _canary_customers():
        renderer = _usable(canary, "PDF_RENDERER_CANARY") or renderer
    return _installed(renderer)


def script_route() -> str | None:
    """'typst' when the script route is on and usable, else None."""
    value = _env("PDF_RENDERER_SCRIPT_ROUTE")
    if not value:
        return None
    if value not in SCRIPT_ROUTES:
        logger.warning("Unknown PDF_RENDERER_SCRIPT_ROUTE value; script route off")
        return None
    if not typst_available():
        logger.warning("PDF_RENDERER_SCRIPT_ROUTE=typst but Typst is not available in this build; "
                       "script route off")
        return None
    return value


def pin(customer_id: str | None) -> dict:
    """The fields pinned on a request when its turn starts:
    {"pdf_renderer": ..., "pdf_script_route": ... | None}."""
    return {"pdf_renderer": base_renderer(customer_id), "pdf_script_route": script_route()}


def pinned_or_resolved(state: dict) -> dict:
    """The renderer fields of a running request: the pinned ones, or (for a
    run enqueued before pinning existed) resolved now."""
    renderer = state.get("pdf_renderer")
    if renderer in RENDERERS:
        route = state.get("pdf_script_route")
        return {"pdf_renderer": _installed(renderer),
                "pdf_script_route": route if route in SCRIPT_ROUTES else None}
    return pin(state.get("customer_id"))


def fonts_cover(letters: set) -> bool:
    """Whether the bundled Typst fonts draw every one of `letters` (the
    letters x2p_v1 cannot draw). False when Typst or its coverage data is not
    available, so a document only moves to Typst when it will render."""
    if not letters:
        return True
    if not typst_available():
        return False
    try:
        from graph_tools.tools import pdf_typst

        check = getattr(pdf_typst, "fonts_cover", None)
        if check is not None:
            return bool(check(set(letters)))
        uncovered = getattr(pdf_typst, "uncovered_characters", None)
        if uncovered is not None:
            return not uncovered("".join(sorted(letters)))
    except Exception:
        logger.warning("PDF font coverage check failed; keeping the document on %s", DEFAULT_RENDERER)
    return False


def resolve(customer_id: str | None, script_hint=None, *, pinned: dict | None = None) -> str:
    """The renderer for one document.

    `pinned` is the request's pinned fields (pin()); without it they are
    resolved now. `script_hint` is pdf_charsets.find_undrawable's result for
    the document: when it holds letters x2p_v1 cannot draw, the script route
    is on and the fonts cover them, the document goes to Typst."""
    fields = pinned or pin(customer_id)
    renderer = fields.get("pdf_renderer") or DEFAULT_RENDERER
    if (
        renderer == "x2p_v1"
        and fields.get("pdf_script_route") == "typst"
        and script_hint is not None
        and getattr(script_hint, "has_unsupported_letters", False)
        and fonts_cover(set(getattr(script_hint, "letters", ())))
    ):
        return "typst"
    return renderer


# Input caps per renderer (plan 1.5, raised for Typst in 5.2 after the Fly
# calibration). x2p_v1 keeps the 1.5 caps; Typst's are env-configurable
# (e.g. PDF_TYPST_MAX_CHARS=300000, PDF_TYPST_MAX_TABLE_ROWS=2500) and default
# to the same values until calibrated.
_DEFAULT_LIMITS = {"max_chars": 150_000, "max_table_rows": 1_000}


def _env_int(name: str, default: int) -> int:
    try:
        value = int(_env(name) or default)
    except ValueError:
        logger.warning("Ignoring non-integer %s", name)
        return default
    return value if value > 0 else default


def limits() -> dict:
    """runtime['pdf_limits']: {renderer: {"max_chars", "max_table_rows"}}."""
    return {
        "x2p_v1": dict(_DEFAULT_LIMITS),
        "typst": {
            "max_chars": _env_int("PDF_TYPST_MAX_CHARS", _DEFAULT_LIMITS["max_chars"]),
            "max_table_rows": _env_int("PDF_TYPST_MAX_TABLE_ROWS", _DEFAULT_LIMITS["max_table_rows"]),
        },
    }
