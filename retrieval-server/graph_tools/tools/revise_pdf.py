"""revise_pdf and read_pdf_source: change a PDF generated on an earlier turn.

On a later turn the model cannot see a PDF's Markdown (built-in calls are not
replayed and the scratch FS is request-scoped), so "change the date" used to
rewrite the whole document from memory and silently reword it. Every PDF
generate_pdf makes now has its exact source stored next to it
('<key>.source.md', ToolContext.save_artifact); these tools read it and apply
exact edits.

Both resolve an artifact id ONLY through the host's
runtime["conversation_files"] ({attachment_id: {s3_key, filename,
media_type, origin}}): the source is read from '<stored s3_key>.source.md',
so a key is never built from model input, and a file generated in another
participant's turn of a shared conversation works too.
"""
import asyncio
import logging
import re

from graph_tools.base import GraphTool, ToolContext, ToolResult
from graph_tools.tools.generate_pdf import render_document

logger = logging.getLogger(__name__)

# Header plus chunk stay under the executor's 8,000-character spill
# threshold, so a page of source is never spilled to scratch.
READ_CHUNK_CHARS = 7_600
MAX_EDITS = 50
_VERSION_RE = re.compile(r"^(?P<stem>.*?) \(v(?P<n>\d{1,4})\)$")

_NO_SOURCE = "Error: no source is stored for this file; regenerate it with generate_pdf instead."


def _resolve(context: ToolContext, artifact_id) -> tuple[dict | None, str | None]:
    """The conversation file for `artifact_id`, or an error text."""
    files = context.runtime.get("conversation_files") or {}
    ref = files.get(str(artifact_id or "").strip())
    if not ref:
        known = [
            f"{fid} ({f.get('filename') or 'file'})"
            for fid, f in files.items()
            if f.get("origin") == "generated" and (f.get("media_type") or "").startswith("application/pdf")
        ]
        listing = "; ".join(known[:20]) if known else "none"
        return None, (
            "Error: that id is not a PDF generated in this conversation. "
            f"Generated PDFs: {listing}."
        )
    if ref.get("origin") != "generated":
        return None, (
            "Error: that file was uploaded by the user, not generated; it has no "
            "editable source. Use read_attachment to read it."
        )
    return ref, None


async def _read_source(context: ToolContext, ref: dict) -> tuple[str | None, str | None]:
    key = f"{ref['s3_key']}.source.md"
    try:
        data = await asyncio.to_thread(context.store.get, key)
    except KeyError:
        return None, _NO_SOURCE
    except Exception:
        logger.warning("revise_pdf: the stored source could not be read")
        return None, "Error: the stored source could not be read right now. Try again."
    return data.decode("utf-8", errors="replace"), None


def _next_filename(filename: str | None) -> str:
    """'report.pdf' -> 'report (v2).pdf'; 'report (v2).pdf' -> 'report (v3).pdf'."""
    name = filename or "document.pdf"
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, "pdf"
    m = _VERSION_RE.match(stem)
    if m:
        return f"{m.group('stem')} (v{int(m.group('n')) + 1}).{ext}"
    return f"{stem} (v2).{ext}"


def apply_edits(source: str, edits) -> tuple[str | None, str | None]:
    """Apply exact find/replace edits in order. Each find must occur exactly
    once in the text as it stands when that edit is applied."""
    if not isinstance(edits, list) or not edits:
        return None, "Error: edits must be a non-empty list of {find, replace} objects."
    if len(edits) > MAX_EDITS:
        return None, f"Error: at most {MAX_EDITS} edits per call."
    text = source
    for i, edit in enumerate(edits, start=1):
        if not isinstance(edit, dict) or not isinstance(edit.get("find"), str):
            return None, f"Error: edit {i} needs a 'find' string and a 'replace' string."
        find = edit["find"]
        replace = edit.get("replace")
        if not isinstance(replace, str):
            return None, f"Error: edit {i} needs a 'replace' string (use \"\" to delete)."
        if not find:
            return None, f"Error: edit {i} has an empty 'find'."
        n = text.count(find)
        if n != 1:
            shown = find if len(find) <= 80 else find[:77] + "..."
            where = "does not occur" if n == 0 else f"occurs {n} times"
            return None, (
                f"Error: the find text of edit {i} ({shown!r}) {where} in the source; "
                "each find must match exactly once. Read the source with "
                "read_pdf_source and copy the exact text (include more context to "
                "make it unique). No file was created."
            )
        text = text.replace(find, replace, 1)
    return text, None


class ReadPdfSourceTool(GraphTool):
    name = "read_pdf_source"
    description = (
        "Read the exact Markdown source of a PDF generated earlier in this "
        "conversation (by its id from a '[Generated file: name, id=...]' note), "
        f"{READ_CHUNK_CHARS:,} characters at a time. Use it before revise_pdf to "
        "copy exact find text."
    )
    parameters = {
        "type": "object",
        "properties": {
            "artifact_id": {"type": "string", "description": "The generated PDF's id."},
            "offset": {
                "type": "integer",
                "description": "Character offset to start from (default 0).",
            },
        },
        "required": ["artifact_id"],
    }

    async def run(self, args: dict, context: ToolContext) -> ToolResult:
        ref, problem = _resolve(context, args.get("artifact_id"))
        if problem:
            return ToolResult(content=problem)
        source, problem = await _read_source(context, ref)
        if problem:
            return ToolResult(content=problem)
        try:
            offset = max(0, int(args.get("offset") or 0))
        except (TypeError, ValueError):
            offset = 0
        chunk = source[offset:offset + READ_CHUNK_CHARS]
        end = offset + len(chunk)
        header = (
            f"Source of {ref.get('filename') or 'the PDF'} "
            f"({len(source):,} chars total, showing {offset:,}-{end:,})"
        )
        if end < len(source):
            header += f"; more remains, continue with offset={end}"
        return ToolResult(content=f"{header}:\n{chunk}")


class RevisePdfTool(GraphTool):
    name = "revise_pdf"
    description = (
        "Change a PDF generated earlier in this conversation by applying exact "
        "find/replace edits to its stored Markdown source, and attach the result "
        "as a new PDF (the original stays). Each 'find' must match the source "
        "exactly once; read the source with read_pdf_source first if you are not "
        "sure of the exact text. Use this instead of regenerating the whole "
        "document, so everything you did not change stays exactly as it was."
    )
    parameters = {
        "type": "object",
        "properties": {
            "artifact_id": {"type": "string", "description": "The generated PDF's id."},
            "edits": {
                "type": "array",
                "description": "Edits applied in order.",
                "items": {
                    "type": "object",
                    "properties": {
                        "find": {"type": "string", "description": "Exact text to replace."},
                        "replace": {"type": "string", "description": "Replacement text."},
                    },
                    "required": ["find", "replace"],
                },
            },
            "filename": {
                "type": "string",
                "description": "Optional new file name; default '<name> (v2).pdf'.",
            },
        },
        "required": ["artifact_id", "edits"],
    }

    async def run(self, args: dict, context: ToolContext) -> ToolResult:
        ref, problem = _resolve(context, args.get("artifact_id"))
        if problem:
            return ToolResult(content=problem)
        source, problem = await _read_source(context, ref)
        if problem:
            return ToolResult(content=problem)
        revised, problem = apply_edits(source, args.get("edits"))
        if problem:
            return ToolResult(content=problem)
        if revised == source:
            return ToolResult(content="Error: the edits change nothing; no file was created.")

        from graph_tools.tools.generate_pdf import _sanitize_filename

        requested = (args.get("filename") or "").strip()
        filename = _sanitize_filename(requested) if requested else _sanitize_filename(
            _next_filename(ref.get("filename"))
        )
        # The stored source is self-contained (a separate title was folded
        # into it as its h1), so it renders without a title argument.
        return await render_document(
            context, revised, filename=filename, revised_from=str(args.get("artifact_id")),
        )
