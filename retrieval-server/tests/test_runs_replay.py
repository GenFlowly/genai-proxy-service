"""
Unit tests for the clean-replay logic in the agent_run body (runs.py, plan 0.4).

The DBOS context is simulated (runs._in_durable_workflow patched); graph,
checkpointer and run_events are fakes, as in test_runs.py. Pinned here:
  * a thread that already has checkpoint values marks a re-execution: the
    run deletes the thread (adelete_thread), counts durable_run_recovered_total
    and publishes content_reset before anything else streams;
  * the check runs once per execution, before the interrupt loop — never after
    an interrupt, where deleting the thread would break Command(resume=...);
  * usage is published once, from the checkpointed state;
  * an answer that replayed from the step memo (so never streamed) is
    published from the final state.
The crash-and-recover tests in test_durable_replay.py run the same paths
against real DBOS.

Run with `python -m unittest tests.test_runs_replay`.
"""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from dbos import DBOS

import durable_metrics
import run_events
import runs

_RUN_INPUT = {
    "customer_id": "cust-1", "client": "test", "data_type": "conversation",
    "raw_data": {"query_data": "hi"}, "llm_provider": "anthropic", "agentic": True,
}


class _Chunk:
    def __init__(self, content):
        self.content = content


class _Graph:
    """`existing` is the checkpoint the thread had when the run started; the
    graph streams `answer` (unless memoized) and may pause on an interrupt."""

    def __init__(self, existing=None, answer="Hello", interrupt_once=False, usage=None):
        self.existing = existing
        self.answer = answer
        self.interrupt_once = interrupt_once
        self.usage = usage or {"total_tokens": 42}
        self.runs = 0
        self.inputs = []

    async def astream_events(self, graph_input, config=None, version=None):
        self.runs += 1
        self.inputs.append(graph_input)
        self.existing = {"generated_response": None}  # a checkpoint exists from now on
        yield {"event": "on_chain_start", "name": "gen", "metadata": {"langgraph_node": "gen"}}
        if self.answer and not (self.interrupt_once and self.runs == 1):
            yield {"event": "on_chat_model_stream", "name": "m", "metadata": {"langgraph_node": "gen"},
                   "data": {"chunk": _Chunk(self.answer)}}

    async def aget_state(self, config):
        paused = self.interrupt_once and self.runs == 1
        values = dict(self.existing or {})
        if self.runs and not paused:
            values = {"generated_response": "Hello", "generated_artifacts": [], "usage": self.usage}
        return SimpleNamespace(
            values=values,
            interrupts=[SimpleNamespace(value={"question": "?"})] if paused else [],
            tasks=[],
        )


class _Checkpointer:
    def __init__(self):
        self.deleted = []

    async def adelete_thread(self, thread_id):
        self.deleted.append(thread_id)


async def _run(graph, durable=True):
    published = []
    checkpointer = _Checkpointer()

    async def fake_publish(run_id, event, terminal=False):
        published.append((event, terminal))
        return len(published)

    def resolve(customer_id, graph_id, cp):
        return graph, {"gen": "RESPONSE_GENERATOR"}, {"gen": "Gen"}, {"gen": {}}, {"gen"}, 10

    with patch.object(runs, "_resolve_durable_graph", resolve), \
            patch.object(runs.durable_runtime, "get_checkpointer", lambda: checkpointer), \
            patch.object(runs, "_in_durable_workflow", lambda: durable), \
            patch.object(run_events, "publish", fake_publish), \
            patch.object(DBOS, "recv_async", AsyncMock(return_value="blue")):
        summary = await runs._run_agent_graph("run_x", dict(_RUN_INPUT))
    return summary, published, checkpointer


def _recovered() -> float:
    return durable_metrics.DURABLE_RUN_RECOVERED._value.get()


class CleanReplayTest(unittest.IsolatedAsyncioTestCase):
    async def test_a_re_execution_deletes_the_thread_and_resets_the_text_first(self):
        before = _recovered()
        _, published, checkpointer = await _run(_Graph(existing={"loop_messages": ["old"]}))
        self.assertEqual(checkpointer.deleted, ["run_x"])
        self.assertEqual(_recovered() - before, 1)
        self.assertEqual(published[0], ({"content_reset": True}, False))

    async def test_a_first_execution_leaves_the_thread_alone(self):
        before = _recovered()
        _, published, checkpointer = await _run(_Graph(existing=None))
        self.assertEqual(checkpointer.deleted, [])
        self.assertEqual(_recovered(), before)
        self.assertNotIn(({"content_reset": True}, False), published)

    async def test_the_graph_restarts_from_the_initial_state(self):
        graph = _Graph(existing={"loop_messages": ["old"]})
        await _run(graph)
        self.assertIsInstance(graph.inputs[0], dict)
        self.assertEqual(graph.inputs[0]["original_query"], "hi")

    async def test_never_inside_the_interrupt_loop(self):
        # After the interrupt the thread has values: deleting it there would
        # lose the paused graph Command(resume=...) continues.
        graph = _Graph(existing=None, interrupt_once=True)
        _, published, checkpointer = await _run(graph)
        self.assertEqual(graph.runs, 2)
        self.assertEqual(type(graph.inputs[1]).__name__, "Command")
        self.assertEqual(checkpointer.deleted, [])

    async def test_a_replayed_interrupted_run_deletes_once_then_resumes(self):
        graph = _Graph(existing={"x": 1}, interrupt_once=True)
        _, _, checkpointer = await _run(graph)
        self.assertEqual(checkpointer.deleted, ["run_x"])
        self.assertEqual(graph.runs, 2)

    async def test_outside_a_durable_workflow_there_is_no_replay_check(self):
        _, _, checkpointer = await _run(_Graph(existing={"x": 1}), durable=False)
        self.assertEqual(checkpointer.deleted, [])


class UsageAndMemoizedAnswerTest(unittest.IsolatedAsyncioTestCase):
    async def test_usage_is_published_once_from_the_checkpointed_state(self):
        summary, published, _ = await _run(_Graph(usage={"total_tokens": 99}))
        usage_rows = [ev for ev, term in published if "usage" in ev and not term]
        self.assertEqual(usage_rows, [{"usage": {"total_tokens": 99}}])
        self.assertEqual(summary["usage"], {"total_tokens": 99})
        # ... right before the terminal summary.
        self.assertIn("usage", published[-2][0])
        self.assertTrue(published[-1][1])

    async def test_a_memoized_answer_is_published_from_the_final_state(self):
        # Re-execution where the answer replayed from the memo: no model events.
        graph = _Graph(existing={"x": 1}, answer="")
        _, published, _ = await _run(graph)
        contents = [ev["content"] for ev, _ in published if "content" in ev]
        self.assertEqual(contents, ["Hello"])
        content_index = next(i for i, (ev, _) in enumerate(published) if "content" in ev)
        reset_index = published.index(({"content_reset": True}, False))
        self.assertLess(reset_index, content_index)

    async def test_a_streamed_answer_is_not_published_twice(self):
        graph = _Graph(existing={"x": 1}, answer="Hello")
        _, published, _ = await _run(graph)
        self.assertEqual([ev["content"] for ev, _ in published if "content" in ev], ["Hello"])

    async def test_a_first_execution_never_republishes_the_answer(self):
        graph = _Graph(existing=None, answer="")
        _, published, _ = await _run(graph)
        self.assertEqual([ev for ev, _ in published if "content" in ev], [])


class LoadGraphStepTest(unittest.TestCase):
    def test_load_graph_returns_the_records_and_built_configs(self):
        record = {"graphId": "g", "customerId": "cust-1", "entryPoint": "gen", "edges": "{}"}
        nodes = [{"nodeId": "gen", "nodeType": "RESPONSE_GENERATOR", "config": '{"is_streaming": true}'}]
        with patch.object(runs, "get_graph_and_nodes_by_id", return_value=(record, nodes)):
            loaded = runs._load_graph_data("cust-1", "g")
        graph_record, loaded_nodes, node_type_map, node_configs, streaming = loaded
        self.assertEqual((graph_record, loaded_nodes), (record, nodes))
        self.assertEqual(node_type_map, {"gen": "RESPONSE_GENERATOR"})
        self.assertEqual(streaming, {"gen"})
        self.assertTrue(node_configs["gen"]["is_streaming"])

    def test_another_customers_graph_is_not_found(self):
        record = {"graphId": "g", "customerId": "cust-2"}
        with patch.object(runs, "get_graph_and_nodes_by_id", return_value=(record, [])):
            with self.assertRaises(ValueError):
                runs._load_graph_data("cust-1", "g")

    def test_no_graph_means_the_direct_fallback(self):
        with patch.object(runs, "get_default_graph_and_nodes", return_value=None):
            self.assertIsNone(runs._load_graph_data("cust-1", None))


if __name__ == "__main__":
    unittest.main()
