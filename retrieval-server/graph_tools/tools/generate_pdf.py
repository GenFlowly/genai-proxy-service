"""generate_pdf: render Markdown to a PDF artifact.

Two renderers sit behind one tool (the host picks one per request, see
graph/pdf_renderer.py):

- "x2p_v1": python-markdown -> HTML -> xhtml2pdf. Pure Python, no system
  dependencies. It draws text with the standard-14 PDF fonts only, so it is
  the bridge engine: scripts it cannot draw are reported honestly
  (pdf_charsets.find_undrawable) instead of silently becoming boxes.
- "typst": the Markdown token tree (pdf_markdown) rendered by Typst with
  bundled Noto fonts (pdf_typst). Shapes Arabic, Hebrew, Indic and CJK text,
  typesets math, sizes table columns from content.

The stylesheet/template lives here, not in the model's hands, so every PDF gets
the same typography whichever LLM wrote the content.

Rendering is CPU- and memory-heavy and untrusted input, so in production it
never runs in the server process: the host injects runtime["render_pdf"], an
async callable that runs `render_job` in a capped, recycled worker child
(graph/pdf_worker.py). Without it (library use, unit tests) the tool renders
in a thread.

Nothing in this module logs or returns document text: render stats are
content-free counts.
"""
import asyncio
import base64
import copy
import html as html_escape
import io
import logging
import re
import time
import unicodedata
from dataclasses import dataclass

from graph_tools.base import GraphTool, ToolContext, ToolResult
from graph_tools.tools.pdf_charsets import find_undrawable, unsupported_script_note

logger = logging.getLogger(__name__)

RENDERERS = ("x2p_v1", "typst")
DEFAULT_RENDERER = "x2p_v1"

# Input caps (plan 1.5): over a cap the tool refuses with an actionable
# message instead of risking the shared machine. The host may raise them per
# renderer (runtime["pdf_limits"], see 5.2) once Typst is calibrated.
DEFAULT_MAX_CHARS = 150_000
DEFAULT_MAX_TABLE_ROWS = 1_000
# x2p_v1 splits long tables into chunks of this many body rows, each
# repeating the header row: 1,000 rows went from 20.7 s / 432 MB to
# 7.4 s / 155 MB, with every row present.
TABLE_CHUNK_ROWS = 50
# xhtml2pdf's own render deadline. The worker kills the child at 120 s; the
# in-engine deadline fires first and maps to the same tool error.
X2P_MAX_RENDER_SECONDS = 110

_CSS = """
@page {
    size: a4 portrait;
    margin: 2cm 1.8cm;
    @frame footer_frame {
        -pdf-frame-content: footer_content;
        bottom: 0.8cm; left: 1.8cm; width: 17.4cm; height: 0.8cm;
    }
}
body { font-family: Helvetica; font-size: 10.5pt; color: #1a1a1a; line-height: 1.5; }
h1 { font-size: 20pt; margin: 0 0 12pt 0; color: #111111; }
h2 { font-size: 15pt; margin: 16pt 0 6pt 0; color: #111111; }
h3 { font-size: 12pt; margin: 12pt 0 4pt 0; color: #111111; }
p { margin: 0 0 8pt 0; }
ul, ol { margin: 0 0 8pt 0; }
li { margin: 0 0 3pt 0; }
table { width: 100%; margin: 6pt 0 10pt 0; }
table.pdf-chunk-notop { margin-top: 0; }
table.pdf-chunk-nobottom { margin-bottom: 0; }
th { background-color: #f0f0f0; font-weight: bold; text-align: left;
     padding: 4pt 6pt; border: 0.5pt solid #cccccc; }
td { padding: 4pt 6pt; border: 0.5pt solid #cccccc; }
code { font-family: Courier; font-size: 9.5pt; color: #333333; }
pre { font-family: Courier; font-size: 9pt; background-color: #f5f5f5;
      padding: 6pt; margin: 6pt 0 10pt 0; }
blockquote { margin: 6pt 0 10pt 12pt; color: #555555; }
hr { border: none; border-top: 0.5pt solid #cccccc; margin: 12pt 0; }
#footer_content { font-size: 8pt; color: #999999; text-align: center; }
"""

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


# --- v1 front end: python-markdown -> HTML ------------------------------------

# Status emoji have no glyph in the standard-14 fonts. These map to symbols
# ZapfDingbats draws (pdf_charsets); everything else stays and is counted as
# an undrawable symbol. Typst renders real colour emoji, so this is v1-only.
_EMOJI_MAP = {
    "✅": "✓",  # white heavy check mark -> check mark
    "✔": "✓",  # heavy check mark
    "❌": "✗",  # cross mark -> ballot x
    "✖": "✗",  # heavy multiplication x
    "⭐": "★",  # white medium star -> black star
    "⬆": "↑",  # up arrow
    "⬇": "↓",  # down arrow
    "➡": "→",  # right arrow
    "⬅": "←",  # left arrow
}
_DROP_CHARS = {"️", "︎"}  # variation selectors


def map_emoji_v1(text: str) -> str:
    if not any(ch in _EMOJI_MAP or ch in _DROP_CHARS for ch in text):
        return text
    return "".join(_EMOJI_MAP.get(ch, ch) for ch in text if ch not in _DROP_CHARS)


# D8: python-markdown needs a blank line before a list or table that follows a
# paragraph line, while LLMs (and the chat UI's CommonMark) don't. This
# pre-pass inserts that blank line, following CommonMark's own rules for
# which lines may interrupt a paragraph, so Markdown that parses today keeps
# its meaning:
#   - a bullet item ('- ', '* ', '+ ') or an ordered item numbered exactly
#     '1. ' / '1) ' (a wrapped "2024. It grew" stays in its paragraph);
#   - a table row ('|') whose next line is a delimiter row;
#   - indented at most 3 spaces, never inside fenced or indented code;
#   - once a list starts, its continuation and lazy lines belong to it until
#     a blank line, so '- a' / '  more' / '- b' stays a tight list.
_FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
_BULLET_RE = re.compile(r"^ {0,3}[-*+][ \t]+\S")
_ORDERED_ONE_RE = re.compile(r"^ {0,3}1[.)][ \t]+\S")
_ANY_ITEM_RE = re.compile(r"^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+\S")
_TABLE_ROW_RE = re.compile(r"^ {0,3}\|")
_DELIM_ROW_RE = re.compile(r"^ {0,3}\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$")
_HR_RE = re.compile(r"^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$")
_HEADING_RE = re.compile(r"^ {0,3}#{1,6}(?:[ \t]|$)")


def d8_prepass(text: str) -> str:
    lines = text.split("\n")
    out: list[str] = []
    fence: str | None = None
    in_list = False
    prev_paragraph = False
    for i, line in enumerate(lines):
        stripped = line.strip()
        if fence is not None:
            out.append(line)
            m = _FENCE_RE.match(line)
            if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= len(fence) \
                    and stripped.strip(fence[0]) == "":
                fence = None
            continue
        m = _FENCE_RE.match(line)
        if m:
            fence = m.group(1)
            out.append(line)
            prev_paragraph = False
            continue
        if not stripped:
            in_list = False
            prev_paragraph = False
            out.append(line)
            continue
        if in_list:
            out.append(line)
            continue
        indent = len(line) - len(line.lstrip(" "))
        is_hr = bool(_HR_RE.match(line))
        is_item = bool(_ANY_ITEM_RE.match(line)) and not is_hr
        if prev_paragraph and indent <= 3 and not is_hr:
            interrupts = bool(_BULLET_RE.match(line) or _ORDERED_ONE_RE.match(line))
            if not interrupts and _TABLE_ROW_RE.match(line):
                nxt = lines[i + 1] if i + 1 < len(lines) else ""
                interrupts = bool(_DELIM_ROW_RE.match(nxt)) and "|" in nxt
            if interrupts:
                out.append("")
        out.append(line)
        if is_item:
            in_list = True
            prev_paragraph = False
        elif indent >= 4 and not prev_paragraph:
            prev_paragraph = False  # an indented code block line
        elif _TABLE_ROW_RE.match(line) or _HEADING_RE.match(line) or is_hr \
                or line.lstrip().startswith(">"):
            prev_paragraph = False
        else:
            prev_paragraph = True
    return "\n".join(out)


def count_table_rows(text: str) -> int:
    """GFM table body rows outside code fences (the 1.5 row cap counts
    these; header and delimiter rows don't count)."""
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


def _build_markdown():
    """python-markdown with raw HTML off, except a small allowlist.

    Raw HTML passthrough made 'Dear <Candidate Name>,' render as 'Dear ,' and
    let model-written <img>/<style> make the renderer fetch URLs. Turning it
    off entirely would regress <br> (the usual GFM way to break a line inside
    a table cell), <sub>, <sup> and <u>, which render today; those four are
    rebuilt as elements, every other tag prints as text."""
    import xml.etree.ElementTree as etree

    import markdown
    from markdown.inlinepatterns import InlineProcessor
    from markdown.treeprocessors import Treeprocessor

    class _AllowedInlineHtml(InlineProcessor):
        def handleMatch(self, m, data):
            if m.group("br") is not None:
                return etree.Element("br"), m.start(0), m.end(0)
            el = etree.Element(m.group("tag").lower())
            el.text = m.group("body")
            return el, m.start(0), m.end(0)

    class _ChunkTables(Treeprocessor):
        """Split long tables into TABLE_CHUNK_ROWS-row tables that repeat the
        header row, with no margin between chunks."""

        def run(self, root):
            for parent in list(root.iter()):
                children = list(parent)
                if not any(c.tag == "table" for c in children):
                    continue
                rebuilt = []
                for child in children:
                    if child.tag != "table":
                        rebuilt.append(child)
                        continue
                    thead = child.find("thead")
                    tbody = child.find("tbody")
                    rows = list(tbody) if tbody is not None else []
                    if len(rows) <= TABLE_CHUNK_ROWS:
                        rebuilt.append(child)
                        continue
                    chunks = [rows[i:i + TABLE_CHUNK_ROWS] for i in range(0, len(rows), TABLE_CHUNK_ROWS)]
                    for n, chunk_rows in enumerate(chunks):
                        table = etree.Element("table", dict(child.attrib))
                        classes = []
                        if n > 0:
                            classes.append("pdf-chunk-notop")
                        if n < len(chunks) - 1:
                            classes.append("pdf-chunk-nobottom")
                        table.set("class", " ".join(classes))
                        if thead is not None:
                            table.append(copy.deepcopy(thead))
                        body = etree.SubElement(table, "tbody")
                        for r in chunk_rows:
                            body.append(r)
                        rebuilt.append(table)
                for c in children:
                    parent.remove(c)
                for c in rebuilt:
                    parent.append(c)
            return None

    class _InspectHeadings(Treeprocessor):
        """Record the first rendered h1 and whether the body starts with it
        (2.7 compares the title against what python-markdown renders)."""

        def run(self, root):
            self.md.first_h1 = None
            self.md.starts_with_h1 = False
            first_block = next(iter(root), None)
            for el in root.iter("h1"):
                self.md.first_h1 = "".join(el.itertext())
                break
            if first_block is not None and first_block.tag == "h1":
                self.md.starts_with_h1 = True
            return None

    md = markdown.Markdown(
        extensions=["tables", "fenced_code", "sane_lists"],
        output_format="html",
    )
    md.preprocessors.deregister("html_block")
    md.inlinePatterns.deregister("html")
    md.inlinePatterns.register(
        _AllowedInlineHtml(
            r"(?P<br><br\s*/?>)|<(?P<tag>sub|sup|u)>(?P<body>[^<>]{1,500}?)</(?P=tag)>",
            md,
        ),
        "allowed_html",
        90,
    )
    md.treeprocessors.register(_ChunkTables(md), "chunk_tables", 5)
    md.treeprocessors.register(_InspectHeadings(md), "inspect_headings", 4)
    return md


# --- render stats & log capture (plan 1.3/1.4) ---------------------------------

class _CountingHandler(logging.Handler):
    """Counts xhtml2pdf log records by kind. Never stores message text:
    xhtml2pdf appends up to 50 whitespace tokens of the source element to
    every warning, i.e. the user's document."""

    def __init__(self):
        super().__init__(logging.DEBUG)
        self.counts: dict[str, int] = {}

    def emit(self, record: logging.LogRecord) -> None:
        if record.levelno < logging.WARNING:
            return
        try:
            template = str(record.msg)
        except Exception:  # pragma: no cover - defensive
            template = ""
        if "can draw" in template:
            kind = "missing_glyph"
        elif "resource policy" in template or "image" in template.lower():
            kind = "image"
        elif "Ignoring" in template or "CSS" in template or "css" in template:
            kind = "css_ignored"
        else:
            kind = "other"
        self.counts[kind] = self.counts.get(kind, 0) + 1


_PAGE_RE = re.compile(rb"/Type\s*/Page(?![a-zA-Z])")


def _count_pages(pdf: bytes) -> int:
    return len(_PAGE_RE.findall(pdf))


class RenderError(Exception):
    """A render that did not produce a PDF. `kind` is one of: oom,
    render_limit, error. Never carries document text."""

    def __init__(self, kind: str):
        super().__init__(kind)
        self.kind = kind


def _out_of_memory(exc: BaseException | None) -> bool:
    """Whether a failed render ran out of memory. Under the worker child's
    address-space cap that is not always a MemoryError: when even raising
    one fails, CPython reports "returned NULL without setting an exception"
    as a SystemError (measured: a 2,000-row table under a 140 MB cap)."""
    seen = 0
    while exc is not None and seen < 10:
        if isinstance(exc, (MemoryError, SystemError)):
            return True
        exc = exc.__cause__ or exc.__context__
        seen += 1
    return False


def render_markdown_pdf(content_markdown: str, title: str | None = None,
                        filename: str | None = None) -> tuple[bytes, dict]:
    """x2p_v1: Markdown -> styled PDF bytes plus content-free stats.

    Raises RenderError(kind)."""
    from xhtml2pdf import pisa
    from xhtml2pdf.config.resources import RenderLimitError, ResourceAccessPolicy

    text = d8_prepass(map_emoji_v1(content_markdown))
    md = _build_markdown()
    body = md.convert(text)
    rendered_h1 = getattr(md, "first_h1", None)
    starts_with_h1 = getattr(md, "starts_with_h1", False)
    shown_title = map_emoji_v1(title) if title else None
    # 2.7: never print the title twice: when the content already starts with
    # an h1 matching it, the content's own h1 is the title.
    if shown_title and starts_with_h1 and \
            _normalize_heading(rendered_h1) == _normalize_heading(shown_title):
        shown_title = None
    pdf_title = title or rendered_h1 or (filename.rsplit(".", 1)[0] if filename else None) or "Document"
    title_html = f"<h1>{html_escape.escape(shown_title)}</h1>" if shown_title else ""
    document = (
        "<html><head>"
        f"<title>{html_escape.escape(pdf_title)}</title>"
        f"<style>{_CSS}</style>"
        "</head><body>"
        f"{title_html}{body}"
        '<div id="footer_content">Page <pdf:pagenumber /> of <pdf:pagecount /></div>'
        "</body></html>"
    )

    # 1.6: no remote fetches and no local reads at all (base_dir=None); data:
    # URI images still render. The deadline fires before the worker's kill.
    policy = ResourceAccessPolicy.server(
        base_dir=None, allow_remote=False, max_render_seconds=X2P_MAX_RENDER_SECONDS
    )
    x2p_logger = logging.getLogger("xhtml2pdf")
    handler = _CountingHandler()
    previous = (x2p_logger.propagate, x2p_logger.level)
    x2p_logger.addHandler(handler)
    x2p_logger.propagate = False
    x2p_logger.setLevel(logging.WARNING)
    buffer = io.BytesIO()
    try:
        result = pisa.CreatePDF(document, dest=buffer, encoding="utf-8", resource_policy=policy)
    except RenderLimitError:
        raise RenderError("render_limit") from None
    except Exception as e:
        raise RenderError("oom" if _out_of_memory(e) else "error") from None
    finally:
        x2p_logger.removeHandler(handler)
        x2p_logger.propagate, level = previous
        x2p_logger.setLevel(level)
    if result.err:
        raise RenderError("error")
    pdf = buffer.getvalue()
    return pdf, {"pages": _count_pages(pdf), "warnings": dict(handler.counts)}


def render_job(job: dict) -> dict:
    """Render one job dict, synchronously; the single entry point used by the
    worker child (graph/pdf_render_child.py) and by the in-thread fallback.

    job: {"renderer", "markdown", "title", "filename", "options"}.
    Returns {"status": "ok", "pdf": bytes, "pages", "warnings", ...stats} or
    {"status": "error", "kind": "oom"|"render_limit"|"error"|"unsupported"}.
    Content-free: no document text in the result except the PDF itself."""
    renderer = job.get("renderer") or DEFAULT_RENDERER
    started = time.process_time()
    try:
        if renderer == "typst":
            try:
                from graph_tools.tools import pdf_typst
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
            pdf = result.pdf
            stats = {
                "pages": result.pages,
                "warnings": dict(result.warnings or {}),
                "missing_glyphs": result.missing_glyphs,
                "math_fallbacks": result.math_fallbacks,
                "images_dropped": result.images_dropped,
            }
            if result.missing_glyphs:
                stats["warnings"]["missing_glyph"] = result.missing_glyphs
        else:
            pdf, stats = render_markdown_pdf(
                job.get("markdown") or "", job.get("title"), job.get("filename")
            )
    except RenderError as e:
        return {"status": "error", "kind": e.kind}
    except Exception as e:
        return {"status": "error", "kind": "oom" if _out_of_memory(e) else "error"}
    return {
        "status": "ok",
        "pdf": pdf,
        "renderer": renderer,
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
    "render_limit": (
        "Error: rendering this document took too long and the PDF was NOT "
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

_SCRIPTS_X2P = (
    "Only Western European (Latin) text renders correctly for now: letters of other "
    "scripts (Arabic, Hebrew, Indic scripts, Chinese, Japanese, Korean, Thai, Cyrillic, "
    "accented Greek, Polish ł, ...) show as boxes."
)
_SCRIPTS_ROUTED = (
    "Text in every major script (Latin, Greek, Cyrillic, Arabic, Hebrew, Indic scripts, "
    "Thai, Chinese, Japanese, Korean) renders correctly; documents that need it are "
    "rendered by a second renderer automatically."
)
_SCRIPTS_TYPST = (
    "Text in every major script (Latin, Greek, Cyrillic, Arabic, Hebrew, Indic scripts, "
    "Thai, Chinese, Japanese, Korean) renders correctly, right-to-left included, as do "
    "colour emoji and TeX math written as \\( ... \\) inline or \\[ ... \\] on its own line."
)


def _description(renderer: str, script_route: str | None, limits: _Limits,
                 fs_enabled: bool, revise_enabled: bool) -> str:
    """The tool description for one request (plan 2.7): the scripts and
    features the active renderer supports, its limits, and the long-document
    and revision paths only when their tools are enabled."""
    typst = renderer == "typst"
    if typst:
        scripts = _SCRIPTS_TYPST
    elif script_route == "typst":
        scripts = _SCRIPTS_ROUTED
    else:
        scripts = _SCRIPTS_X2P
    markdown = (
        "Supported Markdown: headings, paragraphs, bold/italic, ordered/unordered and "
        "nested lists, tables, fenced code blocks, blockquotes and horizontal rules"
        + (", plus strikethrough, task lists (- [x]) and footnotes." if typst else ".")
    )
    page = (
        "Set page_size (A4, Letter or Legal) or orientation (portrait or landscape) only "
        "when the user asks; by default they follow the user's locale."
        if typst else "Pages are A4 portrait."
    )
    parts = [
        "Create a PDF document and attach it to the conversation for the user to "
        "download. Call this when the user asks for a PDF, a downloadable or printable "
        "document, or an export of content. If details are missing (names, dates, "
        "addresses, etc.), call the tool anyway with clearly marked placeholders in "
        "[Square Brackets] rather than asking clarifying questions first.",
        "Pass the COMPLETE document in content_markdown: the PDF contains exactly what "
        "you pass.",
        markdown,
        scripts,
        page,
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


def _parameters(typst: bool, fs_enabled: bool) -> dict:
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
    if typst:
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

    The base renderer is the request's pinned one (runtime["pdf_renderer"]);
    with the script route on, a document whose letters x2p_v1 cannot draw
    goes to Typst when the bundled fonts cover them. Caps apply to the
    effective renderer. The render itself runs in the host's worker child
    (runtime["render_pdf"]) or, without one, in a thread."""
    started = time.perf_counter()
    base_renderer = context.runtime.get("pdf_renderer") or DEFAULT_RENDERER
    if base_renderer not in RENDERERS:
        base_renderer = DEFAULT_RENDERER

    undrawable = find_undrawable(f"{title or ''}\n{content}")
    renderer = base_renderer
    if (
        base_renderer == "x2p_v1"
        and context.runtime.get("pdf_script_route") == "typst"
        and undrawable.has_unsupported_letters
    ):
        covers = context.runtime.get("pdf_fonts_cover")
        if covers is None or covers(undrawable.letters):
            renderer = "typst"

    limits = _limits_for(context.runtime.get("pdf_limits"), renderer)
    rows = count_table_rows(content)
    reason = "chars" if len(content) > limits.max_chars else (
        "table_rows" if rows > limits.max_table_rows else None
    )
    if reason:
        return ToolResult(
            content=(
                "Error: the document is too large and the PDF was NOT created "
                f"({len(content):,} characters, {rows:,} table rows). Shorten the "
                "document or split it into several PDFs (limits: "
                f"{limits.max_chars:,} characters and {limits.max_table_rows:,} "
                "table rows per PDF)."
            ),
            details={"pdf": {
                "status": "rejected", "reason": reason, "renderer": renderer,
                "input_chars": len(content),
            }},
        )

    options = await _render_options(context, renderer)
    if renderer == "typst":
        if page_size in PAGE_SIZES:
            options["page_size"] = page_size
        if orientation in ORIENTATIONS:
            options["orientation"] = orientation
    job = {
        "renderer": renderer,
        "markdown": content,
        "title": title,
        "filename": filename,
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
    if renderer == "x2p_v1":
        warnings = dict(stats.get("warnings") or {})
        if undrawable.scripts:
            warnings["unsupported_script"] = sum(undrawable.scripts.values())
        if undrawable.symbols:
            warnings["unsupported_symbol"] = undrawable.symbols
        stats["warnings"] = warnings
    if outcome.get("status") != "ok":
        kind = outcome.get("kind") or "error"
        # The engine's own deadline (render_limit) is a timeout too.
        status = "timeout" if kind == "render_limit" else kind
        stats["status"] = status if status in ("oom", "timeout", "busy") else "error"
        return ToolResult(content=_ERROR_TEXT.get(kind, _ERROR_TEXT["error"]),
                          details={"pdf": stats})

    pdf_bytes = outcome["pdf"]
    pages = outcome.get("pages")
    artifact = await asyncio.to_thread(
        context.save_artifact, pdf_bytes, "application/pdf", filename,
        source=_source_for(content, title), page_count=pages,
    )
    stats.update({"status": "ok", "pdf_bytes": len(pdf_bytes)})
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
    if renderer == "x2p_v1":
        note = unsupported_script_note(undrawable)
        if note:
            text = f"{text}\n\n{note}"
    return ToolResult(content=text, artifacts=[artifact], details={"pdf": stats})


async def _render_options(context: ToolContext, renderer: str) -> dict:
    """Renderer options from the host's runtime facts: locale (6.1) and the
    tenant's branding settings (6.2). Typst-only; x2p_v1 ignores them."""
    if renderer != "typst":
        return {}
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
    if branding:
        options["branding"] = branding
    return options


async def _load_logo(context: ToolContext, logo_id: str) -> bytes | None:
    """The tenant logo, only ever from the tenant's own attachment prefix
    (the key comes from the host's template and the request's customer id,
    never from model input), so an id belonging to another customer is not
    found. At most 2 MB; the renderer validates the image itself."""
    if not re.fullmatch(r"[A-Za-z0-9-]{8,64}", logo_id):
        return None
    key = context.key_template.format(customer_id=context.customer_id, artifact_id=logo_id)
    try:
        data = await asyncio.to_thread(context.store.get, key)
    except Exception:
        logger.warning("generate_pdf: tenant logo could not be loaded")
        return None
    return data if len(data) <= 2 * 1024 * 1024 else None


class GeneratePdfTool(GraphTool):
    name = "generate_pdf"
    description = _description(DEFAULT_RENDERER, None, _Limits(), False, False)
    parameters = _parameters(False, False)

    def spec_for(self, ctx=None) -> dict:
        if ctx is None:
            return self.spec
        host = ctx.host or {}
        renderer = host.get("pdf_renderer") if host.get("pdf_renderer") in RENDERERS else DEFAULT_RENDERER
        fs_enabled = "fs_write" in ctx.enabled
        return {
            "name": self.name,
            "description": _description(
                renderer, host.get("pdf_script_route"),
                _limits_for(host.get("pdf_limits"), renderer),
                fs_enabled, "revise_pdf" in ctx.enabled,
            ),
            "parameters": _parameters(renderer == "typst", fs_enabled),
        }

    async def run(self, args: dict, context: ToolContext) -> ToolResult:
        renderer = context.runtime.get("pdf_renderer") or DEFAULT_RENDERER
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
