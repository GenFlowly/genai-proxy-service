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


class RecursionLimitFloorTests(unittest.TestCase):
    def test_single_node_graph_gets_a_runnable_recursion_limit(self):
        # maxIterations is handed to LangGraph as recursion_limit, which counts
        # every superstep — 1 can never complete even a one-node pass
        # (GRAPH_RECURSION_LIMIT killed all title generation on 2026-10-14).
        # The builder must floor it to node count + 1.
        graph_record = {
            "graphId": "GRP1",
            "entryPoint": "gen",
            "maxIterations": "1",
            "edges": json.dumps({"edges": [{"from": "gen", "to": "__end__"}]}),
        }
        nodes = [{"nodeId": "gen", "nodeType": "GENERATION", "config": "{}"}]
        _, max_iterations = _build_workflow(graph_record, nodes)
        self.assertGreaterEqual(max_iterations, 2)


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
        # The TOOL_EXECUTOR config must NAME its tools: the harness tools are
        # all explicit-only (never part of the implicit all-built-ins
        # default), so an unscoped config would silently drop them.
        _, nodes = _load()
        executor = next(n for n in nodes if n["nodeType"] == "TOOL_EXECUTOR")
        for tool in ("search_knowledge_base", "write_todos", "fs_write",
                     "fs_read", "fs_list", "spawn_agent"):
            self.assertIn(tool, executor["config"]["tools"])

    def test_generator_carries_the_harness_config(self):
        # Harness prompt + budgets are DATA on the node config — the runtime
        # reads exactly these keys (llm_node), so renames here break silently
        # without this pin.
        _, nodes = _load()
        generator = next(n for n in nodes if n["nodeType"] == "RESPONSE_GENERATOR")
        config = generator["config"]
        self.assertIn("write_todos", config["harness_prompt"])
        self.assertIn("spawn_agent", config["harness_prompt"])
        self.assertGreater(config["max_turn_tokens"], 0)
        self.assertGreater(config["compaction_threshold_tokens"], 0)


if __name__ == "__main__":
    unittest.main()
