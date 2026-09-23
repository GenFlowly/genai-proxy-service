"""Tool providers: the tiers a customer's tool can be backed by.

A provider turns a stored, non-secret tool RECORD into GraphTools the rest of
the graph treats like any other. `http` is one record to one tool; `mcp` is one
record (a server) to many. The package exists so a new tier plugs in without any
call site learning about it.
"""
from graph_tools.providers.http_tool import HttpTool, ToolDefinitionError
from graph_tools.providers.mcp_tool import McpTool, mcp_tools_from_record

__all__ = ["HttpTool", "McpTool", "ToolDefinitionError", "mcp_tools_from_record"]
