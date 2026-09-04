"""Wires the graph_tools package into this server.

Single place that knows the deployment specifics: the shared registry
instance, the attachments bucket, and the S3 key convention (which must match
the Kotlin proxy server's attachmentS3Key so generated artifacts are served
through the existing attachment-download endpoint).
"""
import os

from graph_tools import S3ArtifactStore, ToolContext, ToolRegistry, default_registry

_registry: ToolRegistry | None = None

# Must match attachmentS3Key() in the proxy server's Attachment.kt.
_ATTACHMENT_KEY_TEMPLATE = "customers/{customer_id}/attachments/{artifact_id}"


def get_registry() -> ToolRegistry:
    global _registry
    if _registry is None:
        _registry = default_registry()
    return _registry


def is_builtin_tool(name: str) -> bool:
    return get_registry().has(name)


def make_tool_context(customer_id: str) -> ToolContext:
    bucket = os.environ.get("ATTACHMENTS_BUCKET", "")
    if not bucket:
        raise RuntimeError("ATTACHMENTS_BUCKET environment variable is not set")
    return ToolContext(
        customer_id=customer_id,
        store=S3ArtifactStore(bucket),
        key_template=_ATTACHMENT_KEY_TEMPLATE,
    )
