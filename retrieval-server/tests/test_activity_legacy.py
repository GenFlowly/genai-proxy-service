"""
Unit tests for activity.legacy: v1 thinking steps → the v2 activity log.

Run with `python -m unittest tests.test_activity_legacy`.

The inputs mirror the shapes found in persisted dev records: model steps with
tool calls only in their "Calling tools" line, tool rounds with and without a
per-call breakdown, the retired web-search and retrieval node steps (titles,
no links), and memory steps whose count lives in a sentence.
"""
import unittest

from activity.legacy import convert
from activity.schema import validate


def _run(node, kind, name, **done):
    return [{"node": node, "name": name, "kind": kind, "status": "running", "label": f"{name}: …"},
            {"node": node, "name": name, "kind": kind, "status": "done", **done}]


def _ends(events):
    return [e for e in events if e["type"] == "step.end"]


class LegacyConversionTests(unittest.TestCase):
    def test_a_tool_turn_becomes_plan_tools_and_answer(self):
        raw = (
            _run("M", "MEMORY", "Memory", detail="Applied 2 core memories; recalled 1 related to this message")
            + _run("A", "LLM", "Agent", prompt="how is weather in bellevue",
                   response="Checking current weather.", reasoning="Checking current weather.",
                   detail='Calling tools: web_search(query="Bellevue weather", topic="news")')
            + _run("T", "TOOL", "Tools", prompt="web_search", detail="Executed 1 tool(s)",
                   calls=[{"name": "web_search", "args": {"query": "Bellevue weather"},
                           "sources": [{"index": 1, "title": "Forecast", "url": "https://weather.example/1"}],
                           "artifacts": [], "error": None}])
            + _run("A", "LLM", "Agent", prompt="how is weather in bellevue", response="It is 12°C [1].",
                   detail="Response generated")
        )
        events = convert(raw, thinking_duration_ms=4200, web_sources=[{"index": 1, "title": "Forecast", "url": "https://weather.example/1"}])
        for e in events:
            validate(e)
        self.assertTrue(all(e["at"] is None for e in events))
        memory, plan, tools, answer = _ends(events)
        self.assertEqual(memory["counts"], {"core": 2, "recalled": 1})
        self.assertNotIn("memories", memory)
        self.assertEqual(plan["outcome"], "tool_calls")
        self.assertEqual(plan["reasoning"], "Checking current weather.")
        self.assertEqual([c["name"] for c in plan["tool_calls"]], ["web_search"])
        self.assertEqual(tools["calls"][0]["id"], plan["tool_calls"][0]["id"])
        self.assertEqual(tools["calls"][0]["result_count"], 1)
        self.assertEqual(answer["outcome"], "answer")
        self.assertEqual(answer["id"], "A:2")
        self.assertEqual(events[-1], {"v": 2, "at": None, "type": "turn.end", "duration_ms": 4200,
                                      "outcome": "completed", "cited": [1]})

    def test_structured_tool_calls_win_over_the_text_line(self):
        raw = _run("A", "LLM", "Agent", detail="Calling tools: x",
                   tool_calls=[{"name": "web_search", "args": {"query": "q"}}])
        plan = _ends(convert(raw))[0]
        self.assertEqual(plan["tool_calls"], [{"id": "A:1#1", "name": "web_search", "args": {"query": "q"}}])

    def test_an_old_tool_round_without_breakdown_keeps_its_tool_names(self):
        raw = _run("T", "TOOL", "Tools", prompt="generate_pdf", response="generate_pdf: PDF written",
                   detail="Executed 1 tool(s)", items=["invoice.pdf"])
        calls = _ends(convert(raw))[0]["calls"]
        self.assertEqual([(c["name"], c["mode"], c["sources"]) for c in calls], [("generate_pdf", "run", [])])

    def test_retired_search_and_retrieval_steps_become_calls_without_links(self):
        raw = (_run("W", "WEB_SEARCH", "Web Search", detail="Found 5 web result(s)", items=["A", "B", "…5"])
               + _run("R", "RETRIEVAL", "Retrieval", detail="Found 0 relevant document(s)", items=[]))
        web, retrieval = _ends(convert(raw))
        self.assertEqual(web["kind"], "tools")
        self.assertEqual(web["calls"][0]["name"], "web_search")
        self.assertEqual(web["calls"][0]["result_count"], 5)
        self.assertEqual(web["calls"][0]["sources"], [])
        self.assertEqual(web["calls"][0]["result_excerpt"], "A; B; …5")
        self.assertEqual(retrieval["calls"][0]["name"], "search_knowledge_base")
        self.assertEqual(retrieval["calls"][0]["result_count"], 0)

    def test_pipeline_nodes_report_their_output_and_only_the_last_answers(self):
        raw = (_run("Q", "LLM", "Query Analyzer", detail="Intent: lookup (needs rewrite: no)", prompt="p", response="{...}")
               + _run("G", "LLM", "Response Generator", detail="Response generated", prompt="p2", response="answer"))
        analyzer, generator = _ends(convert(raw))
        self.assertEqual(analyzer["outcome"], "output")
        self.assertEqual(analyzer["summary"], "Intent: lookup (needs rewrite: no)")
        self.assertEqual(analyzer["developer"], {"prompt_excerpt": "p", "response_excerpt": "{...}"})
        self.assertEqual(generator["outcome"], "answer")
        self.assertEqual(generator["developer"], {"prompt_excerpt": "p2"})

    def test_memory_texts_survive_in_either_v1_form(self):
        split = _ends(convert(_run("M", "MEMORY", "Memory", memories={"core": ["a", "b"], "recalled": ["c"]})))[0]
        self.assertEqual(split["counts"], {"core": 2, "recalled": 1})
        self.assertEqual(split["memories"], {"core": ["a", "b"], "recalled": ["c"]})
        flat = _ends(convert(_run("M", "MEMORY", "Memory", detail="Applied 2 learned memori(es)", items=["a", "b"])))[0]
        self.assertEqual(flat["counts"], {"core": 2, "recalled": 0})
        none = _ends(convert(_run("M", "MEMORY", "Memory", detail="No stored memories to apply")))[0]
        self.assertEqual(none["counts"], {"core": 0, "recalled": 0})

    def test_a_step_that_never_finished_has_a_start_and_no_end(self):
        raw = [{"node": "A", "name": "Agent", "kind": "LLM", "status": "running"}]
        events = convert(raw)
        self.assertEqual([e["type"] for e in events], ["turn.start", "step.start", "turn.end"])
        self.assertNotIn("cited", events[-1])
        self.assertNotIn("duration_ms", events[-1])

    def test_nothing_to_convert(self):
        self.assertEqual(convert([]), [])
        self.assertEqual(convert(None), [])
        self.assertEqual(convert([{"no": "node"}, "junk"]), [])


if __name__ == "__main__":
    unittest.main()
