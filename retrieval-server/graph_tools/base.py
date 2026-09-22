"""Core types: GraphTool, ToolContext, ToolResult, Artifact."""
import uuid
from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass, field

from graph_tools.storage import ArtifactStore


@dataclass
class Artifact:
    """A file a tool produced, already persisted to the artifact store."""

    artifact_id: str
    key: str  # storage key (e.g. S3 object key)
    media_type: str
    filename: str
    size_bytes: int

    def to_dict(self) -> dict:
        return {
            "artifact_id": self.artifact_id,
            "key": self.key,
            "media_type": self.media_type,
            "filename": self.filename,
            "size_bytes": self.size_bytes,
        }


@dataclass
class ToolResult:
    """What a tool hands back to the model (content) and to the host
    application (artifacts, for persistence and download links)."""

    content: str
    artifacts: list[Artifact] = field(default_factory=list)


def _no_secrets(credential_ref: str) -> dict:
    """Default secrets accessor: the host injected none, so every tool sees an
    empty credential map and must degrade gracefully (see GraphTool.run)."""
    return {}


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

    def save_artifact(self, data: bytes, media_type: str, filename: str) -> Artifact:
        artifact_id = str(uuid.uuid4())
        key = self.key_template.format(
            customer_id=self.customer_id, artifact_id=artifact_id
        )
        self.store.put(key, data, media_type)
        return Artifact(
            artifact_id=artifact_id,
            key=key,
            media_type=media_type,
            filename=filename,
            size_bytes=len(data),
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

    @abstractmethod
    async def run(self, args: dict, context: ToolContext) -> ToolResult: ...
