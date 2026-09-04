"""Built-in, backend-executed tools for LangGraph agent loops.

Self-contained by design: depends only on the Python stdlib plus the renderer
libraries of individual tools — never on retrieval-server internals — so the
package can be extracted into a standalone open-source library unchanged.

The host application:
  1. builds a ToolContext per request (customer id + artifact store),
  2. binds `registry.specs(...)` to its response-generating LLM alongside any
     caller-defined tools,
  3. routes builtin tool calls to `registry.get(name).run(args, context)` from
     a tool-executor graph node.
"""
from graph_tools.base import Artifact, GraphTool, ToolContext, ToolResult
from graph_tools.registry import ToolRegistry, default_registry
from graph_tools.storage import ArtifactStore, LocalDiskArtifactStore, S3ArtifactStore

__all__ = [
    "Artifact",
    "ArtifactStore",
    "GraphTool",
    "LocalDiskArtifactStore",
    "S3ArtifactStore",
    "ToolContext",
    "ToolRegistry",
    "ToolResult",
    "default_registry",
]
