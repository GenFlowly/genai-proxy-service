"""Scratch filesystem tools: fs_write, fs_read, fs_list.

A per-request working space for the agent loop — notes, intermediate results,
and the spill target for oversized tool outputs (see tool_executor). Backed by
the same artifact store as generated files, under run-scoped keys:

    customers/{customer_id}/agent-fs/{fs_namespace}/{path}

The namespace is one uuid per request, minted by the TOOL_EXECUTOR node and
pinned in the run's scratch state, so it is stable across loop iterations and
across a durable resume, and two concurrent runs can never see each other's
files. Tenant isolation holds by construction: the prefix is built by the host
from ToolContext (customer_id + runtime["fs_prefix"]), never from a model
argument, and paths are validated so no traversal can escape it.

Request-scoped by design (v1): nothing is cleaned up eagerly — the bucket's
lifecycle policy owns expiry — but no later request can address an earlier
namespace. Cross-conversation persistence is a separate product decision.

Lives in graph/ (not graph_tools/) with the other server-local tools; the
storage backend itself stays the generic ArtifactStore.
"""
import logging
import posixpath
import re

from graph_tools.base import GraphTool, ToolContext, ToolResult


def _scratch_tags() -> dict:
    """Tags for scratch objects: the bucket's lifecycle rule expires
    retention=scratch after a few days (tools_runtime.SCRATCH_TAGS)."""
    from graph.tools_runtime import SCRATCH_TAGS

    return dict(SCRATCH_TAGS)

logger = logging.getLogger(__name__)

_MAX_FILE_BYTES = 2_000_000
_DEFAULT_READ_CHARS = 6_000
_MAX_READ_CHARS = 30_000
_PATH_SEGMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ -]{0,80}$")

_NO_NAMESPACE_MSG = (
    "The scratch filesystem is not available in this run. Proceed without it."
)


def safe_path(raw) -> str | None:
    """Normalize a model-supplied path to a safe relative key suffix, or None.

    Rejects traversal ('..'), absolute paths, backslashes, hidden/empty
    segments and characters outside a conservative allowlist — the path is
    about to be appended to a tenant-scoped storage prefix, so anything
    suspicious is refused rather than repaired."""
    if not isinstance(raw, str):
        return None
    path = raw.strip().strip("/")
    if not path or "\\" in path or len(path) > 300:
        return None
    normalized = posixpath.normpath(path)
    if normalized.startswith(("..", "/")):
        return None
    segments = normalized.split("/")
    if len(segments) > 8:
        return None
    for segment in segments:
        if segment.startswith(".") or not _PATH_SEGMENT_RE.match(segment):
            return None
    return normalized


def _prefix(context: ToolContext) -> str | None:
    """The run's FS key prefix, or None when the host provided no namespace."""
    return context.runtime.get("fs_prefix") or None


class FsWriteTool(GraphTool):
    name = "fs_write"
    credential_ref = None
    description = (
        "Write (or overwrite) a text file in your private scratch space for "
        "this task. Use it to keep notes, drafts, and intermediate results out "
        "of the conversation, especially anything large you may want to "
        "re-read later. Paths are relative, e.g. 'notes/findings.md'. With "
        "mode 'append' the content is added to the end of the file (created "
        "if missing), so a long document can be written section by section."
    )
    parameters = {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Relative file path, e.g. 'notes/plan.md'.",
            },
            "content": {"type": "string", "description": "The file content (or the part to append)."},
            "mode": {
                "type": "string",
                "enum": ["overwrite", "append"],
                "description": "'overwrite' (default) replaces the file; 'append' adds to its end.",
            },
        },
        "required": ["path", "content"],
    }

    async def run(self, args: dict, context: ToolContext) -> ToolResult:
        prefix = _prefix(context)
        if prefix is None:
            return ToolResult(content=_NO_NAMESPACE_MSG)
        path = safe_path(args.get("path"))
        if path is None:
            return ToolResult(
                content=(
                    "Error: invalid path. Use a short relative path of plain "
                    "segments, e.g. 'notes/findings.md' — no '..', no leading "
                    "'/', no hidden files."
                )
            )
        mode = str(args.get("mode") or "overwrite").strip().lower()
        if mode not in ("overwrite", "append"):
            return ToolResult(content="Error: mode must be 'overwrite' or 'append'.")
        data = str(args.get("content") or "").encode("utf-8")
        key = f"{prefix}{path}"
        if mode == "append":
            # S3 has no append: read, concatenate, write back. Calls of one
            # round run concurrently, but this method has no await between
            # the read and the write, so appends to one file in one round
            # still land in the order the model made them.
            try:
                data = context.store.get(key) + data
            except KeyError:
                pass
            except Exception as e:
                logger.error("fs_write: append read FAILED for %s — %s", path, e, exc_info=True)
                return ToolResult(
                    content=f"Error: could not append to '{path}'. Continue without it."
                )
        if len(data) > _MAX_FILE_BYTES:
            return ToolResult(
                content=(
                    f"Error: {'the file would be' if mode == 'append' else 'content is'} "
                    f"{len(data)} bytes; the limit is {_MAX_FILE_BYTES}. Split it "
                    "across smaller files."
                )
            )
        try:
            context.store.put(key, data, "text/plain; charset=utf-8", tags=_scratch_tags())
        except Exception as e:
            logger.error("fs_write: FAILED for %s — %s", path, e, exc_info=True)
            return ToolResult(
                content=f"Error: could not write '{path}'. Continue without it."
            )
        verb = "Appended to" if mode == "append" else "Wrote"
        return ToolResult(
            content=f"{verb} {path} ({len(data)} bytes now).",
            state_patch={"fs_files": {path: len(data)}},
        )


class FsReadTool(GraphTool):
    name = "fs_read"
    credential_ref = None
    description = (
        "Read a file from your scratch space. Large files are read in slices: "
        "pass offset/length (in characters) to page through; the result states "
        "the file's total size so you know whether more remains."
    )
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Relative file path."},
            "offset": {
                "type": "integer",
                "description": "Character offset to start from (default 0).",
            },
            "length": {
                "type": "integer",
                "description": (
                    f"How many characters to read (default {_DEFAULT_READ_CHARS}, "
                    f"max {_MAX_READ_CHARS})."
                ),
            },
        },
        "required": ["path"],
    }

    async def run(self, args: dict, context: ToolContext) -> ToolResult:
        prefix = _prefix(context)
        if prefix is None:
            return ToolResult(content=_NO_NAMESPACE_MSG)
        path = safe_path(args.get("path"))
        if path is None:
            return ToolResult(content="Error: invalid path.")
        try:
            offset = max(0, int(args.get("offset") or 0))
        except (TypeError, ValueError):
            offset = 0
        try:
            length = int(args.get("length") or _DEFAULT_READ_CHARS)
        except (TypeError, ValueError):
            length = _DEFAULT_READ_CHARS
        length = max(1, min(length, _MAX_READ_CHARS))

        try:
            text = context.store.get(f"{prefix}{path}").decode("utf-8", errors="replace")
        except KeyError:
            return ToolResult(
                content=f"Error: '{path}' does not exist. Use fs_list to see what does."
            )
        except Exception as e:
            logger.error("fs_read: FAILED for %s — %s", path, e, exc_info=True)
            return ToolResult(content=f"Error: could not read '{path}'.")

        total = len(text)
        chunk = text[offset:offset + length]
        end = offset + len(chunk)
        header = f"{path} ({total} chars total, showing {offset}-{end})"
        if end < total:
            header += f" — more remains; continue with offset={end}"
        return ToolResult(content=f"{header}:\n{chunk}")


class FsListTool(GraphTool):
    name = "fs_list"
    credential_ref = None
    description = "List the files in your scratch space, with sizes in bytes."
    parameters = {"type": "object", "properties": {}}

    async def run(self, args: dict, context: ToolContext) -> ToolResult:
        prefix = _prefix(context)
        if prefix is None:
            return ToolResult(content=_NO_NAMESPACE_MSG)
        try:
            objects = context.store.list(prefix)
        except Exception as e:
            logger.error("fs_list: FAILED — %s", e, exc_info=True)
            return ToolResult(content="Error: could not list the scratch space.")
        if not objects:
            return ToolResult(content="The scratch space is empty.")
        lines = [
            f"{o['key'][len(prefix):]} ({o['size']} bytes)"
            for o in objects
            if o.get("key", "").startswith(prefix)
        ]
        return ToolResult(content="Files in your scratch space:\n" + "\n".join(lines))
