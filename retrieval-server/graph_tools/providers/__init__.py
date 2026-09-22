"""Tool providers: the tiers a customer's tool can be backed by.

A provider turns a stored, non-secret tool RECORD into a GraphTool the rest of
the graph treats like any other. `http` is the first; the package exists so a
second (e.g. MCP) plugs in without any call site learning about it.
"""
from graph_tools.providers.http_tool import HttpTool, ToolDefinitionError

__all__ = ["HttpTool", "ToolDefinitionError"]
