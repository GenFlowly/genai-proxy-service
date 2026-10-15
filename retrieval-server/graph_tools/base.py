"""Core types: GraphTool, ToolContext, ToolResult, Artifact."""
import uuid
from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass, field

from graph_tools.storage import ArtifactStore

# Namespace of the deterministic artifact ids (ToolContext.artifact_seed).
_ARTIFACT_ID_NAMESPACE = uuid.UUID("5c3f6a52-0b6e-4d0e-9a51-7b8e2f4c1d93")


@dataclass
class Artifact:
    """A file a tool produced, already persisted to the artifact store."""

    artifact_id: str
    key: str  # storage key (e.g. S3 object key)
    media_type: str
    filename: str
    size_bytes: int
    # Storage key of the source the artifact was rendered from (e.g. a PDF's
    # Markdown, stored at '<key>.source.md'), so it can be revised later and
    # purged with the artifact. None when no source was stored.
    source_key: str | None = None
    # Page count for paged documents (PDFs), when the renderer reported it.
    page_count: int | None = None

    def to_dict(self) -> dict:
        d = {
            "artifact_id": self.artifact_id,
            "key": self.key,
            "media_type": self.media_type,
            "filename": self.filename,
            "size_bytes": self.size_bytes,
        }
        # Optional fields are omitted rather than sent as null: the host reads
        # them as optional, and an explicit null must not become the string
        # "null" in a lenient JSON reader.
        if self.source_key:
            d["source_key"] = self.source_key
        if self.page_count is not None:
            d["page_count"] = self.page_count
        return d


@dataclass
class Source:
    """A citable source a tool grounded its result in (a web page, a document,
    an API record).

    Tool-agnostic: any tool that answers from fetched sources returns these, and
    the host numbers them with a running [n] index across the turn, renders them
    into the tool's text for the model to read, and forwards {index, title, url}
    to the client so the inline [n] markers in the answer become clickable
    links. Tools therefore never number their own sources — the host owns the
    numbering, which is the only way it stays consistent across several tool
    calls in one turn."""

    title: str
    url: str
    content: str = ""          # snippet the model reads under the [n] header
    published_date: str = ""   # optional; surfaced when the tool has it

    def to_dict(self) -> dict:
        d: dict = {"title": self.title, "url": self.url}
        if self.content:
            d["content"] = self.content
        if self.published_date:
            d["published_date"] = self.published_date
        return d


@dataclass
class ToolResult:
    """What a tool hands back to the model (content + cited sources) and to the
    host application (artifacts, for persistence and download links).

    content   — free text the model reads. When `sources` is set, the host
                appends the numbered source list to it, so `content` should be a
                short preamble here, never a hand-numbered list.
    sources   — citable sources (see Source); the host numbers, renders and
                forwards them. Empty for tools that don't ground in sources.
    artifacts — files the tool produced, for the host to persist.
    state_patch — key/values the host merges into its free-form run state
                (the graph's scratch channel). How keys are merged is the
                host's policy; tools just declare what changed (e.g. a todo
                list, a file-index entry). Never carries secrets.
    usage     — LLM token usage this tool itself incurred (a tool that runs a
                sub-agent reports the child's spend here), accumulated by the
                host into the run's usage accounting. None for ordinary tools.
    details   — structured extras for the host's observability/trace layer
                (e.g. a sub-agent's own step trace). Never shown to the model."""

    content: str = ""
    artifacts: list[Artifact] = field(default_factory=list)
    sources: list["Source"] = field(default_factory=list)
    state_patch: dict = field(default_factory=dict)
    usage: dict | None = None
    details: dict = field(default_factory=dict)


def _no_secrets(credential_ref: str) -> dict:
    """Default secrets accessor: the host injected none, so every tool sees an
    empty credential map and must degrade gracefully (see GraphTool.run)."""
    return {}


@dataclass(frozen=True)
class SpecContext:
    """What a request enables, for per-request tool specs (GraphTool.spec_for).

    enabled      — every tool name bound for the request;
    host         — host facts a tool's description may depend on, e.g.
                   {"pdf_renderer": "typst", "pdf_limits": {...}}. A plain
                   dict, so this package needs no knowledge of the host's
                   configuration."""

    enabled: frozenset = frozenset()
    host: dict = field(default_factory=dict)


@dataclass
class ToolContext:
    """Per-request execution context injected by the host application.

    key_template maps an artifact id to a storage key — the host owns the key
    convention (e.g. "customers/{customer_id}/attachments/{artifact_id}");
    tools only ever call save_artifact.

    secrets maps a tool's credential_ref to the caller's decrypted credential
    values for THIS request. It is a plain callable over an already-resolved
    map, never a live fetch: the host resolves credentials once per run, off
    the event loop, before any tool executes. Tools therefore never reach for
    process environment variables (shared by every tenant in this single
    async process) and no secret is ever placed in graph state (which the
    durable runtime checkpoints to Postgres).
    """

    customer_id: str
    store: ArtifactStore
    key_template: str = "{artifact_id}"
    secrets: Callable[[str], dict] = _no_secrets
    # Deterministic artifact ids (durable runs): when the host sets a seed —
    # one per tool call, through dataclasses.replace, which also resets the
    # counter — the n-th artifact of the call gets uuid5(seed:n) instead of a
    # random uuid4, so a re-executed call writes the same key, not a new one.
    artifact_seed: str | None = None
    _artifact_count: int = field(default=0, init=False, repr=False, compare=False)

    # Host-injected runtime services/facts beyond credentials: the scratch-FS
    # key prefix for this run ("fs_prefix"), the agent-nesting depth ("depth"),
    # the configured subagent profiles ("subagents"), a spawn callable
    # ("spawn"), … Kept a plain dict so this package needs no knowledge of the
    # host's agent machinery; tools that need an entry must degrade gracefully
    # when the host did not provide it.
    runtime: dict = field(default_factory=dict)
    # Object tags the host wants on every artifact this context stores (e.g.
    # {"retention": "pending"} until the host's persistence layer claims it).
    # None stores untagged. Tag semantics are the host's policy.
    artifact_tags: dict | None = None

    def save_artifact(
        self,
        data: bytes,
        media_type: str,
        filename: str,
        *,
        source: str | None = None,
        page_count: int | None = None,
    ) -> Artifact:
        """Persist an artifact (and, when given, the text it was rendered
        from) and describe it for the host.

        `source` is stored at '<key>.source.md' with the same tags, so a later
        turn can revise the document from its exact source and a purge can
        find the sidecar from the artifact's key. The sidecar is not an
        artifact of its own: it is never listed for download."""
        artifact_id = str(uuid.uuid4())
        if self.artifact_seed:
            self._artifact_count += 1
            artifact_id = str(uuid.uuid5(
                _ARTIFACT_ID_NAMESPACE, f"{self.artifact_seed}:{self._artifact_count}"
            ))
        key = self.key_template.format(
            customer_id=self.customer_id, artifact_id=artifact_id
        )
        self.store.put(
            key, data, media_type, tags=self.artifact_tags, filename=filename
        )
        source_key = None
        if source is not None:
            source_key = f"{key}.source.md"
            stem = filename.rsplit(".", 1)[0] if "." in filename else filename
            self.store.put(
                source_key,
                source.encode("utf-8"),
                "text/markdown; charset=utf-8",
                tags=self.artifact_tags,
                filename=f"{stem}.md",
            )
        return Artifact(
            artifact_id=artifact_id,
            key=key,
            media_type=media_type,
            filename=filename,
            size_bytes=len(data),
            source_key=source_key,
            page_count=page_count,
        )


class GraphTool(ABC):
    """A backend-executed tool.

    `name`/`description`/`parameters` (a JSON Schema object) form the spec the
    model sees — vendor-agnostic; the host translates it to each LLM provider.
    `run` is the implementation the backend executes when the model calls it.

    `credential_ref` names the credential this tool needs, if any. The host
    resolves it per request and exposes the values through
    `context.secrets(credential_ref)`. None means the tool needs no caller
    credential. The spec the model sees never includes it.
    """

    name: str
    description: str
    parameters: dict
    credential_ref: str | None = None

    @property
    def spec(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
        }

    def spec_for(self, ctx: "SpecContext | None" = None) -> dict:
        """The spec for one request. Tools whose right description depends on
        what else the request enables (or on host facts such as the active
        renderer) override this; the default is the static `spec`."""
        return self.spec

    @abstractmethod
    async def run(self, args: dict, context: ToolContext) -> ToolResult: ...
