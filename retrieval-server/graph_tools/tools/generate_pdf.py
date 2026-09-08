"""generate_pdf: render markdown to a PDF artifact.

Pure-Python pipeline (markdown -> HTML -> xhtml2pdf) so the package installs
anywhere without system dependencies. The stylesheet lives here, not in the
model's hands — every PDF gets the same typography regardless of which LLM
wrote the content.
"""
import asyncio
import html as html_escape
import io
import logging
import re

from graph_tools.base import GraphTool, ToolContext, ToolResult

logger = logging.getLogger(__name__)

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
table { width: 100%; margin: 6pt 0 10pt 0; border-collapse: collapse; }
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

_FILENAME_SAFE_RE = re.compile(r"[^\w.\- ]+")


def _sanitize_filename(raw: str | None) -> str:
    name = _FILENAME_SAFE_RE.sub("", (raw or "").strip().replace("/", "-")).strip()
    if not name or name.startswith("."):
        name = "document"
    if not name.lower().endswith(".pdf"):
        name += ".pdf"
    return name[:120]


def render_markdown_pdf(content_markdown: str, title: str | None = None) -> bytes:
    """Markdown -> styled PDF bytes. Raises RuntimeError when rendering fails."""
    import markdown
    from xhtml2pdf import pisa

    body = markdown.markdown(
        content_markdown,
        extensions=["tables", "fenced_code", "sane_lists"],
        output_format="html5",
    )
    title_html = f"<h1>{html_escape.escape(title)}</h1>" if title else ""
    document = (
        "<html><head>"
        f"<title>{html_escape.escape(title or 'Document')}</title>"
        f"<style>{_CSS}</style>"
        "</head><body>"
        f"{title_html}{body}"
        '<div id="footer_content">Page <pdf:pagenumber /> of <pdf:pagecount /></div>'
        "</body></html>"
    )

    buffer = io.BytesIO()
    result = pisa.CreatePDF(document, dest=buffer, encoding="utf-8")
    if result.err:
        raise RuntimeError(f"PDF rendering failed with {result.err} error(s)")
    return buffer.getvalue()


class GeneratePdfTool(GraphTool):
    name = "generate_pdf"
    description = (
        "Create a PDF document and attach it to the conversation for the user to "
        "download. Call this when the user asks for a PDF, a downloadable or "
        "printable document, or an export of content. If details are missing "
        "(names, dates, addresses, etc.), call the tool anyway with reasonable "
        "placeholders rather than asking clarifying questions first — the user "
        "can request changes afterwards. Pass the COMPLETE document "
        "in content_markdown — the rendered PDF contains exactly what you pass, "
        "formatted with headings, lists, tables, and code blocks."
    )
    parameters = {
        "type": "object",
        "properties": {
            "content_markdown": {
                "type": "string",
                "description": (
                    "Full document content in Markdown. Supported: headings, "
                    "paragraphs, bold/italic, ordered/unordered lists, tables, "
                    "fenced code blocks, blockquotes, horizontal rules."
                ),
            },
            "filename": {
                "type": "string",
                "description": "File name for the PDF, e.g. 'quarterly-report.pdf'.",
            },
            "title": {
                "type": "string",
                "description": (
                    "Optional document title — rendered as the top heading and set "
                    "as PDF metadata. Omit if content_markdown already starts with "
                    "a title heading."
                ),
            },
        },
        "required": ["content_markdown", "filename"],
    }

    async def run(self, args: dict, context: ToolContext) -> ToolResult:
        content = (args.get("content_markdown") or "").strip()
        if not content:
            return ToolResult(
                content="Error: content_markdown is empty — pass the full document content."
            )
        filename = _sanitize_filename(args.get("filename"))
        title = args.get("title") or None

        pdf_bytes = await asyncio.to_thread(render_markdown_pdf, content, title)
        artifact = await asyncio.to_thread(
            context.save_artifact, pdf_bytes, "application/pdf", filename
        )
        logger.info(
            "generate_pdf: rendered '%s' (%d bytes) for customer=%s as %s",
            filename, len(pdf_bytes), context.customer_id, artifact.artifact_id,
        )
        return ToolResult(
            content=(
                f"PDF '{filename}' ({len(pdf_bytes)} bytes) was created and attached "
                "to this conversation — the user can download it from the message. "
                "Briefly tell the user the document is ready and summarize what it "
                "contains; do NOT repeat the full document text in your reply, and "
                "NEVER write file paths, URLs, or download links (e.g. sandbox:/ "
                "paths) — the file is attached to the message automatically by the "
                "platform."
            ),
            artifacts=[artifact],
        )
