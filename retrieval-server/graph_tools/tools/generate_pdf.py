"""generate_pdf: render Markdown to a PDF artifact.

The Markdown token tree (pdf_markdown) is rendered by Typst with bundled Noto
fonts (pdf_typst): it shapes Arabic, Hebrew, Indic and CJK text, typesets
math and sizes table columns from content. Typst is the only renderer: the
xhtml2pdf bridge renderer ("x2p_v1") was removed (plan 5.2), and a request
still pinned to it renders with Typst (see graph/pdf_renderer.py).

The template lives with the renderer, not in the model's hands, so every PDF
gets the same typography whichever LLM wrote the content.

Rendering is CPU- and memory-heavy and untrusted input, so in production it
never runs in the server process: the host injects runtime["render_pdf"], an
async callable that runs `render_job` in a capped one-shot worker child
(graph/pdf_worker.py). Without it (library use, unit tests) the tool renders
in a thread.

Nothing in this module logs or returns document text: render stats are
content-free counts.
"""
import asyncio
import base64
import importlib
import logging
import re
import time
from dataclasses import dataclass

from graph_tools.base import GraphTool, ToolContext, ToolResult

logger = logging.getLogger(__name__)

RENDERERS = ("typst",)
DEFAULT_RENDERER = "typst"

# Input caps (plan 1.5): over a cap the tool refuses with an actionable
# message instead of risking the shared machine. The host may raise them
# (runtime["pdf_limits"], see 5.2) once Typst is calibrated.
DEFAULT_MAX_CHARS = 150_000
DEFAULT_MAX_TABLE_ROWS = 1_000

# --- filenames and titles (plan 2.7) -----------------------------------------

_FILENAME_UNSAFE_RE = re.compile(r"[^\w.\-() ]+")
_MAX_STEM = 116  # + ".pdf" = 120


def _sanitize_filename(raw: str | None) -> str:
    """A safe, friendly '<stem>.pdf'.

    Whitespace runs collapse; any other extension is replaced (report.docx ->
    report.pdf) instead of appended; the stem is cut before '.pdf' is added,
    so a long name never loses its extension."""
    name = (raw or "").strip().replace("/", "-").replace("\\", "-")
    name = _FILENAME_UNSAFE_RE.sub("", name)
    name = " ".join(name.split())
    stem, dot, ext = name.rpartition(".")
    if dot and ext.lower() == "pdf" and stem.strip(" .-"):
        stem = stem.strip(" .-")
        return f"{stem[:_MAX_STEM].rstrip(' .-')}.{ext}"  # 'report.PDF' is kept
    if dot and ext and len(ext) <= 5 and stem.strip():
        name = stem.strip()  # replace the existing extension (report.docx)
    name = name.strip(" .-")
    if not name:
        name = "document"
    return f"{name[:_MAX_STEM].rstrip(' .-') or 'document'}.pdf"


def _normalize_heading(text: str | None) -> str:
    return " ".join((text or "").split()).casefold()


# --- the table-row cap (plan 1.5) --------------------------------------------

_FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
_DELIM_ROW_RE = re.compile(r"^ {0,3}\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$")


def count_table_rows(text: str) -> int:
    """GFM table body rows outside code fences (the 1.5 row cap counts
    these; header and delimiter rows don't count).

    A line scan, not pdf_markdown's token tree: the cap is checked in the
    server process before anything is rendered, so it must stay cheap on
    input of any size. For the tables models write it counts what the tree
    holds (tests/test_generate_pdf.py compares the two); it undercounts
    shapes they rarely write (a '|-|' delimiter row, a table inside a
    blockquote, continuation rows without a pipe), which the worker child's
    memory and time caps still bound."""
    lines = text.split("\n")
    rows = 0
    fence: str | None = None
    in_table = False
    i = 0
    while i < len(lines):
        line = lines[i]
        m = _FENCE_RE.match(line)
        if fence is not None:
            if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= len(fence):
                fence = None
            i += 1
            continue
        if m:
            fence = m.group(1)
            in_table = False
            i += 1
            continue
        if in_table:
            if line.strip() and "|" in line:
                rows += 1
                i += 1
                continue
            in_table = False
        nxt = lines[i + 1] if i + 1 < len(lines) else ""
        if "|" in line and _DELIM_ROW_RE.match(nxt) and "|" in nxt:
            in_table = True
            i += 2  # header + delimiter
            continue
        i += 1
    return rows


# --- rendering (runs in the worker child) --------------------------------------

def _renderer(value) -> str:
    """The renderer for a pinned value: itself when this build has it, else
    the default. "x2p_v1" (removed in 5.2), which a request enqueued before
    the removal can still carry, renders with Typst."""
    return value if value in RENDERERS else DEFAULT_RENDERER


def _out_of_memory(exc: BaseException | None) -> bool:
    """Whether a failed render ran out of memory. Under the worker child's
    address-space cap that is not always a MemoryError: when even raising
    one fails, CPython reports "returned NULL without setting an exception"
    as a SystemError."""
    seen = 0
    while exc is not None and seen < 10:
        if isinstance(exc, (MemoryError, SystemError)):
            return True
        exc = exc.__cause__ or exc.__context__
        seen += 1
    return False


def render_job(job: dict) -> dict:
    """Render one job dict with Typst, synchronously; the single entry point
    used by the worker child (graph/pdf_render_child.py) and by the in-thread
    fallback. A job naming another renderer ("x2p_v1" from before 5.2, or
    anything unknown) renders with Typst too.

    job: {"renderer", "markdown", "title", "options"}.
    Returns {"status": "ok", "pdf": bytes, "renderer", "pages", "warnings",
    ...stats} or {"status": "error", "kind": "oom"|"error"|"unsupported"}.
    Content-free: no document text in the result except the PDF itself."""
    started = time.process_time()
    try:
        try:
            pdf_typst = importlib.import_module("graph_tools.tools.pdf_typst")
        except ImportError:
            return {"status": "error", "kind": "unsupported"}
        options = dict(job.get("options") or {})
        branding = options.get("branding")
        if branding and branding.get("logo_b64"):
            branding = dict(branding)
            branding["logo"] = base64.b64decode(branding.pop("logo_b64"))
            options["branding"] = branding
        result = pdf_typst.render_markdown_typst(
            job.get("markdown") or "",
            job.get("title"),
            pdf_typst.TypstRenderOptions(**{
                k: v for k, v in options.items()
                if k in pdf_typst.TypstRenderOptions.__dataclass_fields__
            }),
        )
        stats = {
            "pages": result.pages,
            "warnings": dict(result.warnings or {}),
            "missing_glyphs": result.missing_glyphs,
            "math_fallbacks": result.math_fallbacks,
            "images_dropped": result.images_dropped,
        }
        if result.missing_glyphs:
            stats["warnings"]["missing_glyph"] = result.missing_glyphs
    except Exception as e:
        return {"status": "error", "kind": "oom" if _out_of_memory(e) else "error"}
    return {
        "status": "ok",
        "pdf": result.pdf,
        "renderer": DEFAULT_RENDERER,
        "render_cpu_seconds": round(time.process_time() - started, 3),
        **stats,
    }


# --- the tool -----------------------------------------------------------------

@dataclass
class _Limits:
    max_chars: int = DEFAULT_MAX_CHARS
    max_table_rows: int = DEFAULT_MAX_TABLE_ROWS


def _limits_for(limits_by_renderer: dict | None, renderer: str) -> _Limits:
    configured = (limits_by_renderer or {}).get(renderer) or {}
    return _Limits(
        max_chars=int(configured.get("max_chars") or DEFAULT_MAX_CHARS),
        max_table_rows=int(configured.get("max_table_rows") or DEFAULT_MAX_TABLE_ROWS),
    )


_ERROR_TEXT = {
    "oom": (
        "Error: the document is too large to render as one PDF and was NOT "
        "created. Shorten it or split it into several smaller PDFs."
    ),
    "timeout": (
        "Error: rendering this document took too long and the PDF was NOT "
        "created. Shorten it or split it into several smaller PDFs."
    ),
    "busy": "Error: the PDF renderer is busy; the PDF was NOT created. Try again shortly.",
    "unsupported": "Error: this PDF renderer is not available; the PDF was NOT created.",
    "error": "Error: rendering the PDF failed and no file was created.",
}

PAGE_SIZES = ("A4", "Letter", "Legal")
ORIENTATIONS = ("portrait", "landscape")

_SCRIPTS = (
    "Text in every major script (Latin, Greek, Cyrillic, Arabic, Hebrew, Indic scripts, "
    "Thai, Chinese, Japanese, Korean) renders correctly, right-to-left included, as do "
    "colour emoji and TeX math written as \\( ... \\) inline or \\[ ... \\] on its own line."
)


def _description(limits: _Limits, fs_enabled: bool, revise_enabled: bool) -> str:
    """The tool description for one request (plan 2.7): the scripts and
    features the renderer supports, its limits, and the long-document and
    revision paths only when their tools are enabled."""
    parts = [
        "Create a PDF document and attach it to the conversation for the user to "
        "download. Call this when the user asks for a PDF, a downloadable or printable "
        "document, or an export of content. If details are missing (names, dates, "
        "addresses, etc.), call the tool anyway with clearly marked placeholders in "
        "[Square Brackets] rather than asking clarifying questions first.",
        "Pass the COMPLETE document in content_markdown: the PDF contains exactly what "
        "you pass.",
        "Supported Markdown: headings, paragraphs, bold/italic, ordered/unordered and "
        "nested lists, tables, fenced code blocks, blockquotes and horizontal rules, "
        "plus strikethrough, task lists (- [x]), footnotes and definition lists; "
        "links may be http, https or mailto.",
        _SCRIPTS,
        "Set page_size (A4, Letter or Legal) or orientation (portrait or landscape) only "
        "when the user asks; by default they follow the user's locale.",
        "Images must be data: URIs; image URLs are not fetched.",
        f"Limits: {limits.max_chars:,} characters and {limits.max_table_rows:,} table "
        "rows per PDF.",
    ]
    if fs_enabled:
        parts.append(
            "For a document too long to write in one call, write it in sections with "
            "fs_write (mode 'append') to a scratch file such as 'docs/report.md', then "
            "call this tool with source_paths=['docs/report.md'] instead of "
            "content_markdown."
        )
    if revise_enabled:
        parts.append(
            "To change a PDF made earlier in this conversation, use revise_pdf with "
            "exact find/replace edits instead of writing the whole document again."
        )
    return " ".join(parts)


def _parameters(fs_enabled: bool) -> dict:
    properties: dict = {
        "content_markdown": {
            "type": "string",
            "description": "The full document content in Markdown.",
        },
        "filename": {
            "type": "string",
            "description": "File name for the PDF, e.g. 'quarterly-report.pdf'.",
        },
        "title": {
            "type": "string",
            "description": (
                "Optional document title, rendered as the top heading and set as PDF "
                "metadata. Omit if content_markdown already starts with a title heading."
            ),
        },
    }
    if fs_enabled:
        properties["source_paths"] = {
            "type": "array",
            "items": {"type": "string"},
            "description": (
                "Scratch files (fs_write paths) whose contents, joined in this order, "
                "are the document. Use instead of content_markdown for long documents."
            ),
        }
    properties["page_size"] = {"type": "string", "enum": list(PAGE_SIZES)}
    properties["orientation"] = {"type": "string", "enum": list(ORIENTATIONS)}
    return {
        "type": "object",
        "properties": properties,
        # With source_paths available, exactly one of the two is required;
        # run() enforces it (JSON Schema "oneOf" is not portable across vendors).
        "required": ["filename"] if fs_enabled else ["content_markdown", "filename"],
    }


def _source_for(content: str, title: str | None) -> str:
    """The Markdown stored next to the PDF (1.9), self-contained: a title
    given separately is prepended as its h1 unless the content already starts
    with it, so re-rendering the stored source alone reproduces the document."""
    if not title:
        return content
    first = content.lstrip().split("\n", 1)[0]
    if first.startswith("# ") and _normalize_heading(first[2:]) == _normalize_heading(title):
        return content
    return f"# {title}\n\n{content}"


def _report(context: ToolContext, stats: dict) -> None:
    """Hand content-free render stats to the host's metrics (runtime
    "record_pdf_stats"); never raises."""
    record = context.runtime.get("record_pdf_stats")
    if record is None:
        return
    try:
        record(stats)
    except Exception:  # metrics must never break a render
        logger.warning("generate_pdf: recording render stats failed")


async def render_document(
    context: ToolContext,
    content: str,
    *,
    filename: str,
    title: str | None = None,
    page_size: str | None = None,
    orientation: str | None = None,
    revised_from: str | None = None,
) -> ToolResult:
    """Render `content` to a PDF artifact (with its source sidecar) and
    describe the result for the model. Shared by generate_pdf and revise_pdf.

    The renderer is the request's pinned one (runtime["pdf_renderer"]) when
    this build has it, else Typst, and the caps are that renderer's. The
    render itself runs in the host's worker child (runtime["render_pdf"])
    or, without one, in a thread."""
    started = time.perf_counter()
    renderer = _renderer(context.runtime.get("pdf_renderer"))

    limits = _limits_for(context.runtime.get("pdf_limits"), renderer)
    rows = count_table_rows(content)
    reason = "chars" if len(content) > limits.max_chars else (
        "table_rows" if rows > limits.max_table_rows else None
    )
    if reason:
        stats = {"status": "rejected", "reason": reason, "renderer": renderer,
                 "input_chars": len(content)}
        _report(context, stats)
        return ToolResult(
            content=(
                "Error: the document is too large and the PDF was NOT created "
                f"({len(content):,} characters, {rows:,} table rows). Shorten the "
                "document or split it into several PDFs (limits: "
                f"{limits.max_chars:,} characters and {limits.max_table_rows:,} "
                "table rows per PDF)."
            ),
            details={"pdf": stats},
        )

    options = await _render_options(context)
    logo_unavailable = options.pop("logo_unavailable", False)
    if page_size in PAGE_SIZES:
        options["page_size"] = page_size
    if orientation in ORIENTATIONS:
        options["orientation"] = orientation
    job = {
        "renderer": renderer,
        "markdown": content,
        "title": title,
        "options": options,
    }
    render = context.runtime.get("render_pdf")
    if render is not None:
        outcome = await render(job)
    else:
        outcome = await asyncio.to_thread(render_job, job)

    stats = {k: v for k, v in outcome.items() if k != "pdf"}
    stats.setdefault("renderer", renderer)
    stats["input_chars"] = len(content)
    stats["render_seconds"] = round(time.perf_counter() - started, 3)
    if logo_unavailable:
        stats["warnings"] = {**(stats.get("warnings") or {}), "branding_logo_unavailable": 1}
    if outcome.get("status") != "ok":
        kind = outcome.get("kind") or "error"
        stats["status"] = kind if kind in ("oom", "timeout", "busy") else "error"
        _report(context, stats)
        return ToolResult(content=_ERROR_TEXT.get(kind, _ERROR_TEXT["error"]),
                          details={"pdf": stats})

    pdf_bytes = outcome["pdf"]
    pages = outcome.get("pages")
    artifact = await asyncio.to_thread(
        context.save_artifact, pdf_bytes, "application/pdf", filename,
        source=_source_for(content, title), page_count=pages,
    )
    stats.update({"status": "ok", "pdf_bytes": len(pdf_bytes)})
    _report(context, stats)
    logger.info(
        "generate_pdf: rendered artifact %s (%d bytes, %s pages, renderer=%s) for customer=%s",
        artifact.artifact_id, len(pdf_bytes), pages, renderer, context.customer_id,
    )
    made = "revised from the earlier PDF and attached" if revised_from else "created and attached"
    text = (
        f"PDF '{filename}' ({len(pdf_bytes)} bytes"
        + (f", {pages} page{'s' if pages != 1 else ''}" if pages else "")
        + f", id={artifact.artifact_id}) was {made} to this conversation; the user "
        "can download it from the message. Briefly tell the user the document is "
        "ready and summarize what it contains; do NOT repeat the full document text in "
        "your reply, and NEVER write file paths, URLs, or download links (e.g. "
        "sandbox:/ paths): the file is attached to the message automatically by the "
        "platform."
    )
    return ToolResult(content=text, artifacts=[artifact], details={"pdf": stats})


async def _render_options(context: ToolContext) -> dict:
    """Renderer options from the host's runtime facts: locale (6.1) and the
    tenant's branding settings (6.2)."""
    options: dict = {}
    locale = context.runtime.get("locale")
    if isinstance(locale, str) and re.fullmatch(r"[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*", locale):
        options["locale"] = locale
    settings = context.runtime.get("pdf_settings") or {}
    page_size = settings.get("default_page_size")
    if page_size in PAGE_SIZES:
        options["page_size"] = page_size
    branding = {
        k: str(settings[k])[:200] for k in ("company_name", "footer_text")
        if settings.get(k)
    }
    accent = settings.get("accent_color")
    if isinstance(accent, str) and re.fullmatch(r"#[0-9A-Fa-f]{6}", accent):
        branding["accent_color"] = accent
    logo_id = settings.get("logo_attachment_id")
    if logo_id:
        logo = await _load_logo(context, str(logo_id))
        if logo:
            branding["logo_b64"] = base64.b64encode(logo).decode("ascii")
        else:
            # Counted with the render's warnings (render_document), so a
            # misconfigured or foreign logo id shows on the dashboard.
            options["logo_unavailable"] = True
    if branding:
        options["branding"] = branding
    return options


# Owner of agents published from the admin panel; its prefix holds only the
# letterhead logos admins upload (POST /admin/letterhead-logo on the proxy).
SYSTEM_OWNER = "System"


async def _load_logo(context: ToolContext, logo_id: str) -> bytes | None:
    """The letterhead logo, read from the graph owner's attachment prefix,
    then from System's: the owner is the graph record's customerId, which the
    host stamps on the node config ("System" for agents published from the
    admin panel, else the customer whose own agent this is), with the
    requesting customer as the fallback. System's prefix holds only
    admin-uploaded letterhead logos, so a customer's fork of a System agent
    keeps its letterhead. The key comes from the host's template, never from
    model input, and no other customer's prefix is ever read: an id belonging
    to another customer is not found and the PDF renders without it. At most
    2 MB; the renderer validates the image."""
    if not re.fullmatch(r"[A-Za-z0-9-]{8,64}", logo_id):
        logger.warning("generate_pdf: letterhead logo id refused (malformed)")
        return None
    owner = context.runtime.get("pdf_settings_owner") or context.customer_id
    if not isinstance(owner, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", owner):
        logger.warning("generate_pdf: letterhead logo refused (no valid graph owner)")
        return None
    for prefix_owner in dict.fromkeys((owner, SYSTEM_OWNER)):
        key = context.key_template.format(customer_id=prefix_owner, artifact_id=logo_id)
        try:
            data = await asyncio.to_thread(context.store.get, key)
        except Exception:
            continue
        return data if len(data) <= 2 * 1024 * 1024 else None
    logger.warning("generate_pdf: letterhead logo not found under the graph owner's or System's files")
    return None


class GeneratePdfTool(GraphTool):
    name = "generate_pdf"
    description = _description(_Limits(), False, False)
    parameters = _parameters(False)

    def spec_for(self, ctx=None) -> dict:
        if ctx is None:
            return self.spec
        host = ctx.host or {}
        renderer = _renderer(host.get("pdf_renderer"))
        fs_enabled = "fs_write" in ctx.enabled
        return {
            "name": self.name,
            "description": _description(
                _limits_for(host.get("pdf_limits"), renderer),
                fs_enabled, "revise_pdf" in ctx.enabled,
            ),
            "parameters": _parameters(fs_enabled),
        }

    async def run(self, args: dict, context: ToolContext) -> ToolResult:
        renderer = _renderer(context.runtime.get("pdf_renderer"))
        content = (args.get("content_markdown") or "").strip()
        source_paths = args.get("source_paths")
        if source_paths:
            if content:
                return self._error(
                    "Error: pass either content_markdown or source_paths, not both.", renderer
                )
            content, problem = self._read_sources(source_paths, context)
            if problem:
                return self._error(problem, renderer)
        if not content:
            return self._error(
                "Error: content_markdown is empty — pass the full document content.", renderer
            )
        return await render_document(
            context,
            content,
            filename=_sanitize_filename(args.get("filename")),
            title=(args.get("title") or "").strip() or None,
            page_size=args.get("page_size"),
            orientation=args.get("orientation"),
        )

    @staticmethod
    def _error(text: str, renderer: str) -> ToolResult:
        return ToolResult(content=text, details={"pdf": {"status": "error", "renderer": renderer}})

    @staticmethod
    def _read_sources(source_paths, context: ToolContext) -> tuple[str, str | None]:
        """The concatenated text of the scratch files (3.6), or an error."""
        enabled = context.runtime.get("enabled_tools")
        read = context.runtime.get("read_scratch")
        if read is None or (enabled is not None and "fs_write" not in enabled):
            return "", ("Error: source_paths needs the scratch filesystem, which is not "
                        "enabled here; pass the document in content_markdown.")
        if not isinstance(source_paths, list) or not all(isinstance(p, str) for p in source_paths):
            return "", "Error: source_paths must be a list of scratch file paths."
        if len(source_paths) > 50:
            return "", "Error: at most 50 source_paths per PDF."
        sections = []
        for path in source_paths:
            try:
                sections.append(read(path))
            except ValueError:
                return "", (f"Error: invalid path '{path[:100]}'. Use the relative path you "
                            "passed to fs_write, e.g. 'docs/report.md'.")
            except KeyError:
                listed = []
                lister = context.runtime.get("list_scratch")
                if lister is not None:
                    try:
                        listed = lister()
                    except Exception:
                        listed = []
                existing = ", ".join(listed[:30]) if listed else "none"
                return "", f"Error: file not found: '{path[:100]}'; existing files: {existing}."
            except Exception:
                logger.warning("generate_pdf: a source path could not be read")
                return "", f"Error: could not read '{path[:100]}'. Try again."
        return "\n\n".join(s.strip("\n") for s in sections).strip(), None
