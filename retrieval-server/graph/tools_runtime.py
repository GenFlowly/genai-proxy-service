"""Wires the graph_tools package into this server.

Single place that knows the deployment specifics: the built-in tool registry,
the attachments bucket, the S3 key convention (which must match the Kotlin
proxy server's attachmentS3Key so generated artifacts are served through the
existing attachment-download endpoint), and how a request's credentials reach
a tool.

Availability is per REQUEST, not per process. `tools_for` / `specs_for` take
the names enabled for the current request (RetrievalState["builtin_tools"],
derived from the customer's TOOL_EXECUTOR node config) plus that request's
customer id, and resolve them to tools. The built-in registry is a process-wide
cache of customer-independent instances; it is never the authority on what a
given request may call.

Resolution order is built-ins first, then the customer's own declarative tools.
A built-in therefore always wins a name collision, so a customer cannot shadow
`web_search` with something of their own and change what that name does.
"""
import logging
import os
from typing import Callable, Iterable, Optional

from graph_tools import (
    ArtifactStore,
    GraphTool,
    S3ArtifactStore,
    SpecContext,
    ToolContext,
    ToolRegistry,
    default_registry,
)

logger = logging.getLogger(__name__)

_registry: ToolRegistry | None = None

# Must match attachmentS3Key() in the proxy server's Attachment.kt.
_ATTACHMENT_KEY_TEMPLATE = "customers/{customer_id}/attachments/{artifact_id}"

# Node-config key the graph loaders (routes/retrieve._build_node_configs) set
# to the graph record's customerId, overwriting any stored value. Files a
# graph's own settings name (the generate_pdf letterhead logo, plan 6.2) are
# read from this owner's prefix only.
GRAPH_OWNER_KEY = "_graph_owner"

# Object tags on everything a tool stores as an artifact (and its source
# sidecar). 'pending' objects are unclaimed: the proxy retags an object
# 'kept' when it persists the message that links it, and a bucket lifecycle
# rule expires whatever stays pending (an artifact of a turn that was never
# persisted). See genai-proxy-server-cdk/lib/s3-stack.ts.
ARTIFACT_TAGS = {"retention": "pending"}
# Agent scratch (fs_write, oversized tool-output spills): request-scoped,
# expired by the bucket's lifecycle rule after a few days.
SCRATCH_TAGS = {"retention": "scratch"}
# Re-derivable sidecars (e.g. text extracted from an uploaded PDF).
DERIVED_TAGS = {"retention": "derived"}

# Built-ins a TOOL_EXECUTOR node must name EXPLICITLY in its config's "tools"
# list — excluded from the all-built-ins enablement default. These are tools
# whose implicit arrival would change the behavior of existing graphs:
# search_knowledge_base would make every pipeline graph with an unscoped
# TOOL_EXECUTOR node retrieve twice (once via its RETRIEVAL node, once when
# the model calls the tool); search_memories exposes learned user memories and
# additionally requires memory consent (MEMORY_CONSENT_TOOLS below); the
# agent-harness tools (todos, scratch FS, subagent spawning) are opt-in
# capabilities an agent graph names, never a behavior an untouched pipeline
# graph silently grows.
_EXPLICIT_ONLY_TOOLS = {
    "search_knowledge_base",
    "search_memories",
    "write_todos",
    "fs_write",
    "fs_read",
    "fs_list",
    "spawn_agent",
}

# Built-ins enabled whenever their parent tool is, for implicit AND explicit
# tool lists (plan 3.2): agent graphs copied from templates carry explicit
# lists, so a new companion would otherwise reach only newly created graphs.
COMPANION_TOOLS = {"generate_pdf": ("revise_pdf", "read_pdf_source")}

# Built-ins enabled by what the REQUEST carries rather than by graph config:
# read_attachment is bound when the conversation has uploaded documents (and
# the graph can execute built-ins at all). Never implicitly enabled otherwise.
REQUEST_SCOPED_TOOLS = frozenset({"read_attachment"})


def with_companions(names: Iterable[str]) -> list[str]:
    """`names` plus the companions of every enabled tool, order kept."""
    out = [n for n in names or [] if n]
    for name in list(out):
        for companion in COMPANION_TOOLS.get(name, ()):
            if companion not in out:
                out.append(companion)
    return out


# Tools that expose the user's learned memories. Bound only when the request
# carries memory consent: routes.retrieve._build_state drops them from
# builtin_tools when memory_enabled is false (the proxy server's governance
# decision — the same gate the MEMORY node honors), and the tool itself
# re-checks context.runtime["memory_enabled"] so a spawned subagent (whose
# state pins memory_enabled=False) can never reach memories even when a
# profile lists the tool.
MEMORY_CONSENT_TOOLS = frozenset({"search_memories"})


def get_registry() -> ToolRegistry:
    """The process-wide registry of BUILT-IN tools.

    Built-ins are customer-independent (their behavior is the same for every
    tenant; only their credentials differ, and those arrive through
    ToolContext.secrets), so one shared instance is correct. Callers deciding
    what a REQUEST may use must go through tools_for/specs_for instead.

    The registry is default_registry() (the extractable graph_tools package)
    plus the server-local tools that need this server's stacks and therefore
    cannot live inside graph_tools (search_knowledge_base → pymilvus/
    encoding_library).
    """
    global _registry
    if _registry is None:
        registry = default_registry()
        from graph.attachment_tools import ReadAttachmentTool
        from graph.fs_tools import FsListTool, FsReadTool, FsWriteTool
        from graph.knowledge_tool import SearchKnowledgeBaseTool
        from graph.memory_tool import SearchMemoriesTool
        from graph.spawn_tool import SpawnAgentTool

        registry.register(SearchKnowledgeBaseTool())
        registry.register(SearchMemoriesTool())
        registry.register(FsWriteTool())
        registry.register(FsReadTool())
        registry.register(FsListTool())
        registry.register(SpawnAgentTool())
        registry.register(ReadAttachmentTool())
        _registry = registry
    return _registry


def all_builtin_tool_names() -> list[str]:
    """Built-in tool names eligible for IMPLICIT enablement — the default for a
    TOOL_EXECUTOR node that does not name a subset. Deliberately covers
    BUILT-INS ONLY (a customer-defined tool is never implicitly enabled) and
    excludes _EXPLICIT_ONLY_TOOLS (see above), so neither a customer tool nor
    a behavior-changing built-in can silently widen an existing graph."""
    return [
        n for n in get_registry().names()
        if n not in _EXPLICIT_ONLY_TOOLS and n not in REQUEST_SCOPED_TOOLS
    ]


def tools_for(names: Iterable[str], customer_id: str | None = None) -> list[GraphTool]:
    """The tools enabled for one request, in the order given.

    Built-ins resolve first; any remaining names are looked up among the
    customer's own declarative tools. Names that match neither are dropped with
    a warning rather than raising, so a stale node config or a tool the customer
    has since deleted cannot break a request. Duplicates collapse.

    customer_id is optional so callers that only care about built-ins (and the
    tests) need not supply one; omitting it simply means no customer tools.
    """
    registry = get_registry()
    ordered: list[str] = []
    seen: set[str] = set()
    for name in names or []:
        if not name or name in seen:
            continue
        seen.add(name)
        ordered.append(name)

    unresolved = {n for n in ordered if not registry.has(n)}
    customer_tools: dict[str, GraphTool] = {}
    if unresolved and customer_id:
        # Imported here: graph.customer_tools reaches for boto3, and this
        # module is imported by the graph_tools-only unit tests.
        from graph.customer_tools import tools_for_customer

        customer_tools = tools_for_customer(customer_id, unresolved)

    resolved: list[GraphTool] = []
    unknown: list[str] = []
    for name in ordered:
        if registry.has(name):
            resolved.append(registry.get(name))
        elif name in customer_tools:
            resolved.append(customer_tools[name])
        else:
            unknown.append(name)
    if unknown:
        logger.warning(
            "Enabled tool(s) %s resolved to nothing — dropped from this request", unknown
        )
    return resolved


def specs_for(
    names: Iterable[str],
    customer_id: str | None = None,
    spec_context: SpecContext | None = None,
) -> list[dict]:
    """Model-facing specs for the request's enabled tools, built per request
    when a SpecContext is given (GraphTool.spec_for: e.g. generate_pdf's
    description depends on the pinned renderer and on whether fs_write and
    revise_pdf are enabled, plan 2.7)."""
    tools = tools_for(names, customer_id)
    if spec_context is None:
        return [t.spec for t in tools]
    return [t.spec_for(spec_context) for t in tools]


def spec_context_for(state: dict, names: Iterable[str]) -> SpecContext:
    """The SpecContext of one request: its enabled tool names and the host
    facts per-request descriptions depend on."""
    from graph import pdf_renderer

    pinned = pdf_renderer.pinned_or_resolved(state)
    return SpecContext(
        enabled=frozenset(n for n in names or () if n),
        host={
            "pdf_renderer": pinned["pdf_renderer"],
            "pdf_script_route": pinned["pdf_script_route"],
            "pdf_limits": pdf_renderer.limits(),
        },
    )


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

    def _backing(self) -> ArtifactStore:
        if self._store is None:
            bucket = os.environ.get("ATTACHMENTS_BUCKET", "")
            if not bucket:
                raise RuntimeError("ATTACHMENTS_BUCKET environment variable is not set")
            self._store = S3ArtifactStore(bucket)
        return self._store

    def put(
        self,
        key: str,
        data: bytes,
        content_type: str,
        *,
        tags: dict | None = None,
        filename: str | None = None,
    ) -> None:
        self._backing().put(key, data, content_type, tags=tags, filename=filename)

    def get(self, key: str) -> bytes:
        return self._backing().get(key)

    def list(self, prefix: str) -> list[dict]:
        return self._backing().list(prefix)


def request_runtime(
    state: dict,
    config: dict | None,
    *,
    store,
    fs_prefix: str | None,
    enabled: Iterable[str] = (),
) -> dict:
    """Per-request facts and services the PDF and file tools read from
    ToolContext.runtime. The tool executor merges this into every context it
    builds; graph_tools never imports host code, so this is how they get:

    - pdf_renderer / pdf_script_route: the renderer pinned when the turn
      started (graph/pdf_renderer.py, plan 2.1), and pdf_fonts_cover for the
      per-document script route;
    - pdf_limits: input caps per renderer (1.5, raised for Typst in 5.2);
    - render_pdf: renders a job in the capped worker child (1.5);
    - conversation_files: {attachment_id: {s3_key, filename, media_type,
      origin, size_bytes}}, the only way file tools resolve an id (3.1);
    - locale and pdf_settings: page size, footer language and tenant branding
      (6.1, 6.2; pdf_settings is the TOOL_EXECUTOR node's
      tool_settings.generate_pdf), and pdf_settings_owner, the graph owner
      whose prefix the settings' logo id is read from;
    - read_scratch / list_scratch: the turn's scratch files for
      generate_pdf(source_paths=...) (3.6), through fs_tools.safe_path;
    - enabled_tools: the names bound this request (descriptions and
      refusal texts mention fs_write or revise_pdf only when enabled).
    """
    from graph import conversation_files, pdf_metrics, pdf_renderer, pdf_worker
    from graph.fs_tools import safe_path

    pinned = pdf_renderer.pinned_or_resolved(state)

    def read_scratch(path: str) -> str:
        # Unlike fs_write (which strips a leading '/'), a source path that
        # looks absolute is refused: the model meant some other file.
        safe = safe_path(path) if isinstance(path, str) and not path.strip().startswith("/") else None
        if safe is None:
            raise ValueError("invalid path")
        if not fs_prefix:
            raise KeyError(path)
        return store.get(f"{fs_prefix}{safe}").decode("utf-8", errors="replace")

    def list_scratch() -> list[str]:
        if not fs_prefix:
            return []
        return [
            o["key"][len(fs_prefix):]
            for o in store.list(fs_prefix)
            if o.get("key", "").startswith(fs_prefix)
        ]

    settings = ((config or {}).get("tool_settings") or {}).get("generate_pdf")
    return {
        "pdf_renderer": pinned["pdf_renderer"],
        "pdf_script_route": pinned["pdf_script_route"],
        "pdf_fonts_cover": pdf_renderer.fonts_cover,
        "pdf_limits": pdf_renderer.limits(),
        "render_pdf": pdf_worker.render_pdf,
        # Called by the PDF tools with their content-free stats. Inside the
        # tool run, i.e. inside the durable tool_invoke step: a recovered
        # run that replays the memoized result does not count it again.
        "record_pdf_stats": pdf_metrics.record,
        "conversation_files": conversation_files.by_id(state.get("conversation_files") or []),
        "locale": state.get("locale"),
        "pdf_settings": dict(settings) if isinstance(settings, dict) else {},
        "pdf_settings_owner": (config or {}).get(GRAPH_OWNER_KEY),
        "read_scratch": read_scratch,
        "list_scratch": list_scratch,
        "enabled_tools": frozenset(enabled or ()),
    }


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
        artifact_tags=dict(ARTIFACT_TAGS),
    )
    if secrets is not None:
        context.secrets = secrets
    return context
