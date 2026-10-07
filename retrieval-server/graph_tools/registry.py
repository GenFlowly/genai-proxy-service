"""Tool registry: the single place all built-in tools are declared."""
from graph_tools.base import GraphTool


class ToolRegistry:
    def __init__(self):
        self._tools: dict[str, GraphTool] = {}

    def register(self, tool: GraphTool) -> None:
        if tool.name in self._tools:
            raise ValueError(f"Tool '{tool.name}' is already registered")
        self._tools[tool.name] = tool

    def has(self, name: str) -> bool:
        return name in self._tools

    def get(self, name: str) -> GraphTool:
        return self._tools[name]

    def names(self) -> list[str]:
        return list(self._tools)

    def specs(self, names: list[str] | None = None) -> list[dict]:
        """Tool specs for LLM binding — all tools, or the named subset (unknown
        names are ignored so a stale node config can't break requests)."""
        if names is None:
            return [t.spec for t in self._tools.values()]
        return [self._tools[n].spec for n in names if n in self._tools]


def default_registry() -> ToolRegistry:
    """Registry with every built-in tool registered."""
    from graph_tools.tools.generate_pdf import GeneratePdfTool
    from graph_tools.tools.web_search import WebSearchTool
    from graph_tools.tools.write_todos import WriteTodosTool

    registry = ToolRegistry()
    registry.register(GeneratePdfTool())
    registry.register(WebSearchTool())
    registry.register(WriteTodosTool())
    return registry
