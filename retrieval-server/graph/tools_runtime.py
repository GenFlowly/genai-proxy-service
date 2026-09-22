"""Wires the graph_tools package into this server.

Single place that knows the deployment specifics: the built-in tool registry,
the attachments bucket, the S3 key convention (which must match the Kotlin
proxy server's attachmentS3Key so generated artifacts are served through the
existing attachment-download endpoint), and how a request's credentials reach
a tool.

Availability is per REQUEST, not per process. `tools_for` / `specs_for` take
the names enabled for the current request (RetrievalState["builtin_tools"],
derived from the customer's TOOL_EXECUTOR node config) and resolve them to
tools. The built-in registry is a process-wide cache of customer-independent
instances; it is never the authority on what a given request may call. That
split is what lets customer-defined tools be added later without any node
reaching for module state: `tools_for` is the one seam a new provider plugs
into.
"""
import logging
import os
from typing import Callable, Iterable, Optional

from graph_tools import (
    ArtifactStore,
    GraphTool,
    S3ArtifactStore,
    ToolContext,
    ToolRegistry,
    default_registry,
)

logger = logging.getLogger(__name__)

_registry: ToolRegistry | None = None

# Must match attachmentS3Key() in the proxy server's Attachment.kt.
_ATTACHMENT_KEY_TEMPLATE = "customers/{customer_id}/attachments/{artifact_id}"


def get_registry() -> ToolRegistry:
    """The process-wide registry of BUILT-IN tools.

    Built-ins are customer-independent (their behavior is the same for every
    tenant; only their credentials differ, and those arrive through
    ToolContext.secrets), so one shared instance is correct. Callers deciding
    what a REQUEST may use must go through tools_for/specs_for instead.
    """
    global _registry
    if _registry is None:
        _registry = default_registry()
    return _registry


def all_builtin_tool_names() -> list[str]:
    """Every built-in tool name. Used as the enablement default for a
    TOOL_EXECUTOR node that does not name a subset — note this deliberately
    covers BUILT-INS ONLY, so a customer-defined tool is never implicitly
    enabled and must always be named explicitly."""
    return get_registry().names()


def tools_for(names: Iterable[str]) -> list[GraphTool]:
    """The tools enabled for one request, in the order given.

    Unknown names are dropped with a warning rather than raising, so a stale
    node config cannot break a request. Duplicates collapse.
    """
    registry = get_registry()
    resolved: list[GraphTool] = []
    seen: set[str] = set()
    unknown: list[str] = []
    for name in names or []:
        if not name or name in seen:
            continue
        seen.add(name)
        if registry.has(name):
            resolved.append(registry.get(name))
        else:
            unknown.append(name)
    if unknown:
        logger.warning(
            "Enabled tool(s) %s are not registered — dropped from this request", unknown
        )
    return resolved


def specs_for(names: Iterable[str]) -> list[dict]:
    """Model-facing specs for the request's enabled tools."""
    return [t.spec for t in tools_for(names)]


def credential_refs_for(tools: Iterable[GraphTool]) -> set[str]:
    """The distinct credential references the given tools need."""
    return {ref for ref in (getattr(t, "credential_ref", None) for t in tools) if ref}


class _LazyAttachmentStore:
    """Defers S3ArtifactStore construction (and the ATTACHMENTS_BUCKET check)
    until a tool actually persists something.

    Built eagerly, a missing bucket would raise while assembling the context —
    outside the executor's per-call error handling — and take down tools that
    never store anything at all (web_search among them). Deferred, the failure
    lands on the one call that needed storage and is reported to the model as
    that tool's error.
    """

    def __init__(self):
        self._store: ArtifactStore | None = None

    def put(self, key: str, data: bytes, content_type: str) -> None:
        if self._store is None:
            bucket = os.environ.get("ATTACHMENTS_BUCKET", "")
            if not bucket:
                raise RuntimeError("ATTACHMENTS_BUCKET environment variable is not set")
            self._store = S3ArtifactStore(bucket)
        self._store.put(key, data, content_type)


def make_tool_context(
    customer_id: str,
    secrets: Optional[Callable[[str], dict]] = None,
) -> ToolContext:
    """Per-request execution context.

    `secrets` maps a tool's credential_ref to that customer's decrypted values.
    Omitting it yields a context whose tools see no credentials — correct for
    tools that need none, and a graceful-degradation path for the rest.
    """
    context = ToolContext(
        customer_id=customer_id,
        store=_LazyAttachmentStore(),
        key_template=_ATTACHMENT_KEY_TEMPLATE,
    )
    if secrets is not None:
        context.secrets = secrets
    return context
