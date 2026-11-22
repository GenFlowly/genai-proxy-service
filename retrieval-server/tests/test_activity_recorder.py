"""
Unit tests for activity.recorder: LangGraph events → the activity log.

Run with `python -m unittest tests.test_activity_recorder`.

The golden tests replay the scripted turns in tests/activity_scenarios.py and
compare the result with tests/fixtures/activity/*.json, the files the client
reducers are tested against. Set REGENERATE_ACTIVITY_FIXTURES=1 to rewrite
them after a deliberate contract change.
"""
import json
import os
import unittest

from activity import ActivityRecorder
from activity.recorder import _llm_payload, _memory_payload
from activity.schema import TURN_COMPLETED, validate
from tests import activity_scenarios as sc


class GoldenLogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.environ.get("REGENERATE_ACTIVITY_FIXTURES") == "1":
            sc.write_all()

    def test_every_scenario_matches_its_fixture(self):
        for scenario in sc.SCENARIOS:
            with self.subTest(scenario=scenario.name):
                path = sc.FIXTURE_DIR / f"{scenario.name}.json"
                self.assertTrue(path.exists(), f"missing fixture {path.name}; regenerate")
                self.assertEqual(json.loads(path.read_text()), json.loads(json.dumps(sc.fixture(scenario))))

    def test_every_fixture_event_honors_the_contract(self):
        for path in sorted(sc.FIXTURE_DIR.glob("*.json")):
            for event in json.loads(path.read_text())["events"]:
                with self.subTest(fixture=path.name, type=event.get("type")):
                    validate(event)

    def test_the_completed_turn_matches_the_design_numbers(self):
        events = sc.run(sc.SCENARIOS[0])
        self.assertEqual(events[-1], {"v": 2, "at": 22000, "type": "turn.end", "duration_ms": 22000,
                                      "outcome": "completed", "cited": [1, 3, 12, 21, 26, 27]})
        tools = [e for e in events if e["type"] == "step.end" and e["kind"] == "tools"]
        calls = [c for t in tools for c in t["calls"]]
        self.assertEqual(len(calls), 6)
        self.assertEqual(sum(len(c["sources"]) for c in calls), 31)
        memory = next(e for e in events if e["type"] == "step.end" and e["kind"] == "memory")
        self.assertEqual(memory["counts"], {"core": 14, "recalled": 2})


def _recorder(clock=None, **kwargs):
    clock = clock or sc.FakeClock()
    return ActivityRecorder(node_type_map=sc.NODE_TYPES, node_name_map=sc.NODE_NAMES,
                            streaming_nodes=sc.STREAMING, started_at=clock.t, clock=clock, **kwargs), clock


def _types(events):
    return [e["type"] for e in events]


class StepCorrelationTests(unittest.TestCase):
    def test_a_node_that_runs_twice_becomes_two_steps(self):
        rec, _ = _recorder()
        out = []
        for ev in (sc.start(sc.AGENT, "r1"), sc.end(sc.AGENT, "r1", {"generated_response": "x", "tool_calls": [{"id": "1", "name": "t"}]}),
                   sc.start(sc.AGENT, "r2"), sc.end(sc.AGENT, "r2", {"generated_response": "done"})):
            out += rec.observe(ev)
        ids = [e["id"] for e in out if e["type"] == "step.end"]
        self.assertEqual(ids, [f"{sc.AGENT}:1", f"{sc.AGENT}:2"])

    def test_events_without_run_ids_correlate_by_node(self):
        rec, _ = _recorder()
        start = {"event": "on_chain_start", "name": sc.MEMORY, "metadata": {"langgraph_node": sc.MEMORY}}
        end = {"event": "on_chain_end", "name": sc.MEMORY, "metadata": {"langgraph_node": sc.MEMORY}, "data": {"output": {}}}
        out = rec.observe(start) + rec.observe(end)
        self.assertEqual(_types(out), ["turn.start", "step.start", "step.end"])
        self.assertEqual(out[-1]["counts"], {"core": 0, "recalled": 0})

    def test_parallel_runs_of_one_node_end_by_run_id(self):
        rec, clock = _recorder()
        rec.observe(sc.start(sc.AGENT, "x"))
        clock.t += 1
        rec.observe(sc.start(sc.AGENT, "y"))
        clock.t += 1
        first_end = rec.observe(sc.end(sc.AGENT, "x", {"generated_response": "a"}))[0]
        self.assertEqual(first_end["id"], f"{sc.AGENT}:1")
        self.assertEqual(first_end["duration_ms"], 2000)

    def test_inner_chains_of_a_node_are_not_steps(self):
        rec, _ = _recorder()
        inner = {"event": "on_chain_start", "name": "RunnableSequence", "metadata": {"langgraph_node": sc.AGENT}}
        self.assertEqual(_types(rec.observe(inner)), ["turn.start"])

    def test_a_subagents_graph_events_are_ignored(self):
        rec, _ = _recorder()
        rec.observe(sc.start(sc.TOOLS, "t"))
        nested = [sc.start("subagent_generator", "c", nested=True),
                  sc.stream("subagent_generator", "hi", nested=True),
                  sc.call_done(sc.TOOLS, {"name": "web_search", "mode": "run"}, nested=True),
                  sc.end("subagent_generator", "c", {"generated_response": "r"}, nested=True)]
        for ev in nested:
            self.assertEqual(rec.observe(ev), [])


class LlmStepTests(unittest.TestCase):
    def test_reasoning_and_calls_are_surfaced_for_a_tool_round(self):
        payload = _llm_payload({"generated_response": "  I'll search the latest.  ",
                                "tool_calls": [{"id": "c1", "name": "web_search", "args": {"query": "MGM"}}]},
                               structured=False)
        self.assertEqual(payload["outcome"], "tool_calls")
        self.assertEqual(payload["reasoning"], "I'll search the latest.")
        self.assertEqual(payload["tool_calls"], [{"id": "c1", "name": "web_search", "args": {"query": "MGM"}}])

    def test_no_reasoning_key_when_the_model_wrote_no_text(self):
        payload = _llm_payload({"generated_response": "", "tool_calls": [{"id": "c1", "name": "t"}]}, structured=False)
        self.assertNotIn("reasoning", payload)

    def test_every_call_of_a_round_is_kept_in_order(self):
        calls = [{"id": f"c{i}", "name": "web_search", "args": {"query": f"q{i}"}} for i in range(3)]
        payload = _llm_payload({"tool_calls": calls}, structured=False)
        self.assertEqual([c["id"] for c in payload["tool_calls"]], ["c0", "c1", "c2"])

    def test_an_answer_and_a_structured_answer(self):
        self.assertEqual(_llm_payload({"generated_response": "Hi"}, structured=False)["outcome"], "answer")
        self.assertEqual(_llm_payload({"generated_response": "{}"}, structured=True)["outcome"], "structured")

    def test_an_intermediate_node_reports_what_it_produced(self):
        payload = _llm_payload({"query_intent": "factual", "needs_rewrite": False}, structured=False)
        self.assertEqual(payload["outcome"], "output")
        self.assertEqual(payload["summary"], "Intent: factual (needs rewrite: no)")

    def test_nothing_produced_is_empty(self):
        self.assertEqual(_llm_payload({"usage": {"input_tokens": 3}, "trace": []}, structured=False)["outcome"], "empty")

    def test_developer_excerpts_skip_text_the_log_already_has(self):
        answer = _llm_payload({"generated_response": "Hi", "trace": sc.trace("prompt", "Hi")}, structured=False)
        self.assertEqual(answer["developer"], {"prompt_excerpt": "prompt"})
        tool_round = _llm_payload({"generated_response": "why", "tool_calls": [{"id": "1", "name": "t"}],
                                   "trace": sc.trace("prompt", "why")}, structured=False)
        self.assertNotIn("response_excerpt", tool_round["developer"])
        other = _llm_payload({"query_intent": "x", "trace": sc.trace("p", "raw output")}, structured=False)
        self.assertEqual(other["developer"]["response_excerpt"], "raw output")

    def test_first_token_is_reported_once_per_step(self):
        rec, clock = _recorder()
        rec.observe(sc.start(sc.AGENT, "a"))
        clock.t += 0.5
        first = rec.observe(sc.stream(sc.AGENT, "Hello"))
        clock.t += 0.5
        again = rec.observe(sc.stream(sc.AGENT, " world"))
        self.assertEqual(first[0]["type"], "step.progress")
        self.assertEqual(first[0]["first_token_ms"], 500)
        self.assertEqual(again, [])
        end = rec.observe(sc.end(sc.AGENT, "a", {"generated_response": "Hello world"}))[0]
        self.assertEqual(end["first_token_ms"], 500)

    def test_tool_call_argument_deltas_are_not_a_first_token(self):
        rec, _ = _recorder()
        rec.observe(sc.start(sc.AGENT, "a"))
        delta = sc.stream(sc.AGENT, "")
        delta["data"]["chunk"].content = [{"type": "tool_use", "input": "{\"q\""}]
        self.assertEqual(rec.observe(delta), [])

    def test_structured_output_never_reports_a_first_token(self):
        rec, _ = _recorder(structured_output=True)
        rec.observe(sc.start(sc.AGENT, "a"))
        self.assertEqual(rec.observe(sc.stream(sc.AGENT, "{\"a\"")), [])

    def test_non_streaming_nodes_never_report_a_first_token(self):
        rec, _ = _recorder()
        rec.observe(sc.start("NODANALYZER", "q"))
        self.assertEqual(rec.observe(sc.stream("NODANALYZER", "factual")), [])


class MemoryStepTests(unittest.TestCase):
    def test_distinguishes_core_and_recalled(self):
        payload = _memory_payload(sc.memory_output(["Core fact A.", "Core fact B."], ["Recalled fact."]))
        self.assertEqual(payload["counts"], {"core": 2, "recalled": 1})
        self.assertEqual(payload["memories"], {"core": ["Core fact A.", "Core fact B."], "recalled": ["Recalled fact."]})

    def test_nothing_is_capped_or_truncated(self):
        long = "L" * 300
        core = [f"Core fact {i}. {long}" for i in range(8)]
        payload = _memory_payload(sc.memory_output(core, [f"Recalled fact. {long}"]))
        self.assertEqual(payload["memories"]["core"], core)
        self.assertEqual(payload["memories"]["recalled"], [f"Recalled fact. {long}"])

    def test_falls_back_to_line_count_without_stats(self):
        payload = _memory_payload({"memories_block": "## What you know\nintro:\n- Core fact A."})
        self.assertEqual(payload["counts"], {"core": 1, "recalled": 0})
        self.assertEqual(payload["memories"]["core"], ["Core fact A."])

    def test_nothing_to_inject_reads_as_zero_memories(self):
        self.assertEqual(_memory_payload({}), {"counts": {"core": 0, "recalled": 0},
                                               "memories": {"core": [], "recalled": []}})


class ToolsStepTests(unittest.TestCase):
    def test_a_finished_call_becomes_a_live_step_call(self):
        rec, _ = _recorder()
        rec.observe(sc.start(sc.TOOLS, "t"))
        out = rec.observe(sc.call_done(sc.TOOLS, {"id": "c", "seq": 1, "name": "web_search", "mode": "run",
                                                  "duration_ms": 900, "result_count": 4, "error": None,
                                                  "secret": "never forwarded"}))
        self.assertEqual(out[0]["type"], "step.call")
        self.assertEqual(out[0]["call"], {"id": "c", "seq": 1, "name": "web_search", "mode": "run",
                                          "duration_ms": 900, "result_count": 4})

    def test_a_call_report_outside_a_tools_step_is_dropped(self):
        rec, _ = _recorder()
        rec.begin()
        self.assertEqual(rec.observe(sc.call_done(sc.TOOLS, {"name": "web_search", "mode": "run"})), [])

    def test_a_malformed_call_report_is_dropped(self):
        rec, _ = _recorder()
        rec.observe(sc.start(sc.TOOLS, "t"))
        self.assertEqual(rec.observe(sc.call_done(sc.TOOLS, {"name": "web_search", "mode": "bogus"})), [])
        self.assertEqual(rec.observe(sc.call_done(sc.TOOLS, "not a dict")), [])

    def test_budget_and_todos_come_from_the_trace_entry(self):
        rec, _ = _recorder()
        rec.observe(sc.start(sc.TOOLS, "t"))
        output = sc.tools_output([], {"used": 2, "max": 5})
        output["trace"][0]["todos"] = [{"content": "Search", "status": "completed"}]
        end = rec.observe(sc.end(sc.TOOLS, "t", output))[0]
        self.assertEqual(end["budget"], {"used": 2, "max": 5})
        self.assertEqual(end["todos"], [{"content": "Search", "status": "completed"}])
        self.assertEqual(end["calls"], [])


class LifecycleTests(unittest.TestCase):
    def test_pause_ends_open_steps_and_excludes_the_wait(self):
        rec, clock = _recorder()
        rec.observe(sc.start(sc.INPUT, "h1"))
        clock.t += 1
        paused = rec.pause()
        self.assertEqual(paused[0]["type"], "step.end")
        self.assertTrue(paused[0]["interrupted"])
        clock.t += 300  # the human takes five minutes
        rec.resume()
        rec.observe(sc.start(sc.INPUT, "h2"))
        clock.t += 1
        resumed_end = rec.observe(sc.end(sc.INPUT, "h2", {}))[0]
        self.assertEqual(resumed_end["id"], f"{sc.INPUT}:2")
        self.assertEqual(resumed_end["at"], 2000)
        self.assertEqual(rec.finish(TURN_COMPLETED)[0]["duration_ms"], 2000)

    def test_finish_is_idempotent_and_closes_the_log(self):
        rec, _ = _recorder()
        self.assertEqual(_types(rec.finish(TURN_COMPLETED)), ["turn.start", "turn.end"])
        self.assertEqual(rec.finish(TURN_COMPLETED), [])
        self.assertEqual(rec.observe(sc.start(sc.AGENT, "late")), [])

    def test_cited_indices_ride_on_turn_end_sorted_and_unique(self):
        rec, _ = _recorder()
        rec.cite([5, 1, 5])
        self.assertEqual(rec.finish(TURN_COMPLETED)[-1]["cited"], [1, 5])

    def test_turn_end_has_no_cited_key_when_nothing_was_found(self):
        rec, _ = _recorder()
        self.assertNotIn("cited", rec.finish(TURN_COMPLETED)[-1])

    def test_turn_start_is_emitted_once(self):
        rec, _ = _recorder()
        self.assertEqual(_types(rec.observe(sc.start(sc.MEMORY, "m"))), ["turn.start", "step.start"])
        self.assertEqual(_types(rec.observe(sc.end(sc.MEMORY, "m", {}))), ["step.end"])


if __name__ == "__main__":
    unittest.main()
