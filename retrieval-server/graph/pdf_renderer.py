"""Which PDF renderer a request uses (plan 2.1, reduced to one renderer in 5.2).

Typst is the only renderer: xhtml2pdf ("x2p_v1") was removed in plan 5.2,
and with it the canary customer list and the script route that chose between
the two. What is left:

- PDF_RENDERER is still read. 'typst' (or unset) is the only valid value; an
  old 'x2p_v1', or anything else, is tolerated: Typst is used and a WARNING
  is logged once per process (never document content).
  PDF_RENDERER_CANARY, PDF_RENDERER_CANARY_CUSTOMERS and
  PDF_RENDERER_SCRIPT_ROUTE are obsolete: they are ignored, with one WARNING
  per process when set.
- The renderer is still resolved once per turn, before the run starts (the
  /retrieve handler, POST /runs before enqueue), and pinned as a declared
  request/state field. A request or a durable run pinned to 'x2p_v1' (one
  enqueued before the removal deploy and recovered after it: plan 0.1 keeps
  the DBOS app version) renders with Typst instead of failing; generate_pdf
  maps any value it does not know to Typst the same way.

There is deliberately no graph node-config override: node config is
customer-editable, and the renderer is an internal engine choice. Changing
an env value changes Fly env, which restarts the single production machine (a
health-gated restart followed by DBOS recovery of in-flight runs).
"""
import logging
import os

logger = logging.getLogger(__name__)

RENDERERS = ("typst",)
DEFAULT_RENDERER = "typst"
# Values from before plan 5.2 that may still be pinned on a recovered durable
# run or set in the environment. They render with DEFAULT_RENDERER.
RETIRED_RENDERERS = ("x2p_v1",)
_OBSOLETE_ENV = ("PDF_RENDERER_CANARY", "PDF_RENDERER_CANARY_CUSTOMERS", "PDF_RENDERER_SCRIPT_ROUTE")

# Warnings already logged by this process: an env value is fixed for the
# process's life (changing Fly env restarts the machine), so once is enough.
_warned: set = set()


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def _warn_once(key, message: str, *args) -> None:
    if key not in _warned:
        _warned.add(key)
        logger.warning(message, *args)


def configured_renderer() -> str:
    """The renderer the environment selects: PDF_RENDERER when it names a
    renderer this build has, else the default."""
    value = _env("PDF_RENDERER")
    if value and value not in RENDERERS:
        if value in RETIRED_RENDERERS:
            _warn_once(("PDF_RENDERER", value),
                       "PDF_RENDERER=%s names a renderer that was removed (plan 5.2); using %s",
                       value, DEFAULT_RENDERER)
        else:
            _warn_once(("PDF_RENDERER", None), "Unknown PDF renderer in PDF_RENDERER; using %s",
                       DEFAULT_RENDERER)
        value = ""
    for name in _OBSOLETE_ENV:
        if _env(name):
            _warn_once((name,), "%s is obsolete since xhtml2pdf was removed (plan 5.2); ignoring it",
                       name)
    return value or DEFAULT_RENDERER


def pin() -> dict:
    """The fields pinned on a request when its turn starts: {"pdf_renderer"}."""
    return {"pdf_renderer": configured_renderer()}


def pinned_or_resolved(state: dict) -> dict:
    """The renderer fields of a running request: the pinned renderer when this
    build has it; otherwise (a run pinned to 'x2p_v1' before the removal, or
    enqueued before pinning existed) the one resolved now."""
    renderer = state.get("pdf_renderer")
    if renderer in RENDERERS:
        return {"pdf_renderer": renderer}
    return pin()


# Input caps (plan 1.5, raised for Typst in 5.2 after the Fly calibration):
# env-configurable (e.g. PDF_TYPST_MAX_CHARS=300000,
# PDF_TYPST_MAX_TABLE_ROWS=2500), the 1.5 values until calibrated.
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
        "typst": {
            "max_chars": _env_int("PDF_TYPST_MAX_CHARS", _DEFAULT_LIMITS["max_chars"]),
            "max_table_rows": _env_int("PDF_TYPST_MAX_TABLE_ROWS", _DEFAULT_LIMITS["max_table_rows"]),
        },
    }
