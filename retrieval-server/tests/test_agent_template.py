"""
Pins graph/templates/agent_loop.json to the engine.

Run with `python -m unittest tests.test_agent_template`.

The template is published as ordinary CustomerGraphs/CustomerGraphNodes
records, so the one thing that can rot silently is the file drifting from what
_build_workflow accepts (an edge schema rename, a node type removal). This
test compiles the template exactly as the loader would.
"""
import json
import unittest
from pathlib import Path

from graph.dynamic_graph import _build_workflow

_TEMPLATE = Path(__file__).resolve().parent.parent / "graph" / "templates" / "agent_loop.json"


def _load():
    template = json.loads(_TEMPLATE.read_text())
    # The loader hands _build_workflow the DDB record shapes: edges may be a
    # JSON string (as stored) and nodes carry nodeId/nodeType.
    graph_record = dict(template["graph"])
    graph_record["edges"] = json.dumps(graph_record["edges"])
    return graph_record, template["nodes"]


class AgentTemplateTests(unittest.TestCase):
    def test_template_compiles_into_a_runnable_graph(self):
        graph_record, nodes = _load()
        workflow, max_iterations = _build_workflow(graph_record, nodes)
        compiled = workflow.compile()  # raises if an edge names a missing node

        self.assertEqual(max_iterations, 40)
        self.assertEqual(
            set(compiled.get_graph().nodes) - {"__start__", "__end__"},
            {"memory", "generator", "tools"},
        )

    def test_loop_exit_contract(self):
        # The tool_route edge must cover all three labels, and only 'builtin'
        # may loop — 'caller' and 'none' are the exits that terminate the run.
        _, nodes = _load()
        template = json.loads(_TEMPLATE.read_text())
        [cond] = template["graph"]["edges"]["conditional_edges"]

        self.assertEqual(cond["condition_type"], "tool_route")
        self.assertEqual(cond["routes"]["builtin"], "tools")
        self.assertEqual(cond["routes"]["caller"], "__end__")
        self.assertEqual(cond["routes"]["none"], "__end__")

    def test_tools_are_scoped_explicitly(self):
        # The TOOL_EXECUTOR config must NAME its tools: search_knowledge_base
        # is explicit-only (never part of the implicit all-built-ins default),
        # so an unscoped config would silently drop it from the agent.
        _, nodes = _load()
        executor = next(n for n in nodes if n["nodeType"] == "TOOL_EXECUTOR")
        self.assertIn("search_knowledge_base", executor["config"]["tools"])


if __name__ == "__main__":
    unittest.main()
