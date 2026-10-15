"""read_attachment: page-level access to documents the user attached (plan 4.3).

A document too large to replay on later turns is replaced by a stub that
points here (graph/documents.py), and sub-agents never receive attachments
directly, so this is how either reads a PDF's pages. The id is resolved only
through runtime["conversation_files"] with origin "uploaded", and the stored
s3_key is used as given: shared conversations work and no key is ever built
from model input. Text comes from the extracted-text sidecar (parsed in the
sandboxed worker child on first use).
"""
import logging
import re

from graph import attachments
from graph_tools.base import GraphTool, ToolContext, ToolResult

logger = logging.getLogger(__name__)

# Header plus text stay under the executor's 8,000-character spill threshold.
MAX_RESULT_CHARS = 7_600
_PAGES_RE = re.compile(r"^\s*(\d{1,5})\s*(?:-\s*(\d{1,5})\s*)?$")


class ReadAttachmentTool(GraphTool):
    name = "read_attachment"
    credential_ref = None
    description = (
        "Read the text of a document (PDF) the user attached to this conversation, "
        "by its id (from a <document ... id=...> header or a '[document ..., id=...]' "
        f"note). Returns at most {MAX_RESULT_CHARS:,} characters; pass pages, e.g. "
        "'3-5' or '7', to read specific pages, and continue where the result says."
    )
    parameters = {
        "type": "object",
        "properties": {
            "attachment_id": {"type": "string", "description": "The document's id."},
            "pages": {
                "type": "string",
                "description": "Pages to read, 1-based: '4' or '3-5'. Default: from page 1.",
            },
        },
        "required": ["attachment_id"],
    }

    async def run(self, args: dict, context: ToolContext) -> ToolResult:
        attachment_id = str(args.get("attachment_id") or "").strip()
        files = context.runtime.get("conversation_files") or {}
        ref = files.get(attachment_id)
        if not ref or ref.get("origin") != "uploaded":
            uploaded = [
                f"{fid} ({f.get('filename') or 'document'})"
                for fid, f in files.items() if f.get("origin") == "uploaded"
            ]
            return ToolResult(content=(
                "Error: that id is not a document attached to this conversation. "
                f"Attached documents: {'; '.join(uploaded[:20]) if uploaded else 'none'}."
            ))
        if not attachments.is_pdf_ref(ref):
            return ToolResult(content="Error: only PDF documents can be read with this tool.")

        doc = await attachments.load({"attachment_id": attachment_id, **ref})
        if doc.status != "ok":
            return ToolResult(content=f"Error: {attachments.user_error(doc)}")
        if not doc.pages:
            return ToolResult(content=f"{doc.filename} has no pages.")

        first, last = 1, doc.pages
        spec = args.get("pages")
        if spec not in (None, ""):
            m = _PAGES_RE.match(str(spec))
            if not m:
                return ToolResult(content="Error: pages must look like '4' or '3-5'.")
            first = int(m.group(1))
            last = int(m.group(2) or m.group(1))
            if first < 1 or last < first or first > doc.pages:
                return ToolResult(content=f"Error: {doc.filename} has pages 1-{doc.pages}.")
            last = min(last, doc.pages)

        header = f"{doc.filename} ({doc.pages} pages), pages {first}-{last}"
        text = doc.text(first - 1, last - 1)
        budget = MAX_RESULT_CHARS - len(header) - 120
        if len(text) > budget:
            text = text[:budget].rstrip()
            # The last page that started within the budget, to continue from.
            shown = [int(n) for n in re.findall(r"^\[page (\d+)", text, flags=re.M)]
            resume = shown[-1] if shown else first
            header = f"{doc.filename} ({doc.pages} pages), from page {first}; cut at page {resume}"
            text += f"\n[... cut here; continue with pages='{resume}-{last}']"
        if doc.scanned:
            text += "\n[Most pages of this document have no extractable text (it appears to be scanned).]"
        return ToolResult(content=f"{header}:\n{text}")
