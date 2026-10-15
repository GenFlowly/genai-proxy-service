"""PDF metrics, registered host-side on the default prometheus registry that
/metrics already serves (app.py). graph_tools never imports prometheus or
encoding_library: the generate_pdf tool returns content-free render stats in
ToolResult.details["pdf"], and the tool executor hands them to `record`.

Buckets go to 300 s (the generic tool_execution histogram stops at 10 s, where
large renders start). `renderer` is the renderer that ran: typst, the only
one since xhtml2pdf (x2p_v1) was removed in plan 5.2.
"""
import logging

from prometheus_client import Counter, Histogram

from graph.pdf_renderer import DEFAULT_RENDERER, RENDERERS

logger = logging.getLogger(__name__)

_SECONDS_BUCKETS = (0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 40, 60, 120, 300)
_STATUSES = ("ok", "error", "oom", "timeout", "busy", "rejected")

RENDER_SECONDS = Histogram(
    "pdf_render_seconds", "Wall time of one generate_pdf call (queue + render + store)",
    ["renderer", "status"], buckets=_SECONDS_BUCKETS,
)
RENDER_CPU_SECONDS = Histogram(
    "pdf_render_cpu_seconds", "CPU seconds the render itself took in the worker child",
    ["renderer"], buckets=_SECONDS_BUCKETS,
)
SPAWN_CPU_SECONDS = Histogram(
    "pdf_worker_spawn_cpu_seconds", "CPU seconds a worker child spent importing its renderer",
    ["renderer"], buckets=_SECONDS_BUCKETS,
)
CHILD_PEAK_RSS = Histogram(
    "pdf_child_peak_rss_bytes", "Peak RSS of the worker child after a render",
    ["renderer"],
    buckets=tuple(mb * 1024 * 1024 for mb in (50, 100, 150, 200, 250, 300, 350, 400, 450, 512)),
)
QUEUE_WAIT_SECONDS = Histogram(
    "pdf_queue_wait_seconds", "Time a render waited for the heavy-job slot",
    buckets=(0.01, 0.1, 0.5, 1, 2, 5, 10, 20, 30, 60),
)
PAGES = Histogram("pdf_pages", "Pages per generated PDF", buckets=(1, 2, 3, 5, 10, 20, 50, 100, 200, 500))
BYTES = Histogram(
    "pdf_bytes", "Size of generated PDFs",
    buckets=tuple(kb * 1024 for kb in (10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000)),
)
INPUT_CHARS = Histogram(
    "pdf_input_chars", "Markdown characters per generate_pdf call",
    buckets=(1000, 5000, 10000, 25000, 50000, 100000, 150000, 300000),
)
WARNINGS = Counter(
    "pdf_render_warnings_total", "Renderer warnings by kind (counts only, never text)",
    ["renderer", "kind"],
)
REJECTED = Counter("pdf_rejected_total", "generate_pdf calls refused before rendering", ["reason"])
TRUNCATED_TOOL_CALLS = Counter(
    "llm_truncated_tool_call_total",
    "Tool calls refused because the model output was cut off or malformed",
    ["tool", "reason"],
)
PDF_INPUT = Counter(
    "pdf_input_total", "Uploaded PDFs sent to a model, by how they were sent",
    ["status", "vendor"],
)
PDF_INPUT_PAGES = Histogram(
    "pdf_input_pages", "Pages per uploaded PDF", buckets=(1, 2, 5, 10, 20, 50, 100, 200, 500, 1000),
)
PDF_EXTRACT_SECONDS = Histogram(
    "pdf_extract_seconds", "Time to inspect/extract an uploaded PDF in the parse child",
    buckets=_SECONDS_BUCKETS,
)
PDF_SIDECAR = Counter("pdf_text_sidecar_total", "Extracted-text sidecar cache lookups", ["result"])

def _renderer(stats: dict) -> str:
    renderer = stats.get("renderer")
    return renderer if renderer in RENDERERS else DEFAULT_RENDERER


def record(stats: dict | None) -> None:
    """Record one generate_pdf call from its content-free stats dict."""
    if not stats:
        return
    try:
        renderer = _renderer(stats)
        status = stats.get("status") if stats.get("status") in _STATUSES else "error"
        if status == "rejected":
            REJECTED.labels(reason=str(stats.get("reason") or "other")[:32]).inc()
        if stats.get("render_seconds") is not None:
            RENDER_SECONDS.labels(renderer=renderer, status=status).observe(float(stats["render_seconds"]))
        if stats.get("render_cpu_seconds") is not None:
            RENDER_CPU_SECONDS.labels(renderer=renderer).observe(float(stats["render_cpu_seconds"]))
        if stats.get("spawn_cpu_seconds") is not None:
            SPAWN_CPU_SECONDS.labels(renderer=renderer).observe(float(stats["spawn_cpu_seconds"]))
        if stats.get("child_peak_rss_bytes"):
            CHILD_PEAK_RSS.labels(renderer=renderer).observe(float(stats["child_peak_rss_bytes"]))
        if stats.get("queue_wait_seconds") is not None:
            QUEUE_WAIT_SECONDS.observe(float(stats["queue_wait_seconds"]))
        if status == "ok":
            if stats.get("pages"):
                PAGES.observe(float(stats["pages"]))
            if stats.get("pdf_bytes"):
                BYTES.observe(float(stats["pdf_bytes"]))
        if stats.get("input_chars") is not None:
            INPUT_CHARS.observe(float(stats["input_chars"]))
        for kind, count in (stats.get("warnings") or {}).items():
            if count:
                WARNINGS.labels(renderer=renderer, kind=str(kind)[:32]).inc(int(count))
    except Exception:  # metrics must never break a tool call
        logger.exception("pdf_metrics.record failed")


def record_truncated(tool: str, reason: str) -> None:
    try:
        TRUNCATED_TOOL_CALLS.labels(tool=str(tool)[:64], reason=str(reason)[:32]).inc()
    except Exception:
        logger.exception("pdf_metrics.record_truncated failed")
