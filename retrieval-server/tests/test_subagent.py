"""
Integration test for graph/subagent.py — a real child loop, stubbed LLM.

Run with `python -m unittest tests.test_subagent`.

run_subagent drives the ACTUAL compiled two-node child graph through llm_node
(only the vendor call is stubbed), so this pins the end-to-end contract:
isolation (the child sees only the delegated prompt, under the subagent
harness), the report/usage flowing back, FS-namespace sharing down the tree,
and failure-as-value instead of an exception.
"""
import unittest
from contextlib import asynccontextmanager
from unittest.mock import patch

from langchain_core.messages import AIMessage

import graph.nodes.llm_node as llm_node_module
from graph.subagent import GENERAL_PROFILE, run_subagent


class _RecorderLLM:
    """Answers immediately (no tool calls → the loop exits) and keeps the
    messages it was sent."""

    def __init__(self):
        self.messages = None

    async def ainvoke(self, messages):
        self.messages = messages
        message = AIMessage(content="child answer")
        message.usage_metadata = {"input_tokens": 7, "output_tokens": 3, "total_tokens": 10}
        return message


def _parent_state() -> dict:
    return {
        "customer_id": "cust-1",
        "client": "test",
        "data_type": "note",
        "request_source": "conversation",
        "llm_provider": "openai",
        "llm_model": "gpt-test",
        "llm_credentials": {"openai_api_key": "k"},
        "conversation_history": [{"role": "user", "content": "PARENT SECRET"}],
        "scratch": {"fs_namespace": "shared-ns"},
    }


class RunSubagentTests(unittest.IsolatedAsyncioTestCase):
    async def _run(self, profile, prompt="Investigate the thing", depth=1):
        recorder = _RecorderLLM()
        with patch.object(
            llm_node_module, "_build_llm_and_structured", return_value=(recorder, None)
        ), patch.object(llm_node_module, "credentials_for", return_value={}):
            out = await run_subagent(_parent_state(), profile, prompt, depth)
        return out, recorder

    async def test_child_answers_and_reports_usage(self):
        out, _ = await self._run(GENERAL_PROFILE)

        self.assertEqual(out["content"], "child answer")
        self.assertEqual(out["usage"]["total_tokens"], 10)
        self.assertIsNone(out["error"])
        self.assertTrue(out["trace"])  # the child's own step trace came back

    async def test_child_is_isolated_but_shares_the_fs_namespace(self):
        out, recorder = await self._run(GENERAL_PROFILE, prompt="the delegated task")

        sent = " ".join(str(m.content) for m in recorder.messages)
        self.assertIn("the delegated task", sent)
        self.assertNotIn("PARENT SECRET", sent)  # no parent conversation leaks
        # The subagent harness frames the child's final message as a report.
        self.assertIn("delegated task. Your final message is returned", sent)

    async def test_profile_persona_and_model_override_apply(self):
        profile = {
            "name": "researcher",
            "prompt": "You are a meticulous researcher.",
            "tools": ["web_search"],
            "model": "gpt-child",
        }
        _, recorder = await self._run(profile)

        system = str(recorder.messages[0].content)
        self.assertIn("You are a meticulous researcher.", system)
        with patch.object(
            llm_node_module, "_build_llm_and_structured", return_value=(_RecorderLLM(), None)
        ) as build, patch.object(llm_node_module, "credentials_for", return_value={}):
            await run_subagent(_parent_state(), profile, "x", 1)
        self.assertEqual(build.call_args.args[2], "gpt-child")  # effective_model

    async def test_child_failure_is_a_value_not_an_exception(self):
        class _Boom:
            async def ainvoke(self, messages):
                raise RuntimeError("vendor down")

        with patch.object(
            llm_node_module, "_build_llm_and_structured", return_value=(_Boom(), None)
        ), patch.object(llm_node_module, "credentials_for", return_value={}):
            out = await run_subagent(_parent_state(), GENERAL_PROFILE, "x", 1)

        self.assertEqual(out["content"], "")
        self.assertIn("vendor down", out["error"])


class _Slot:
    """Records the child_slot protocol run_subagent follows on /runs."""

    def __init__(self, log):
        self.log = log

    @asynccontextmanager
    async def start(self):
        self.log.append("start turn")
        try:
            yield
        finally:
            self.log.append("started")

    @asynccontextmanager
    async def result(self):
        self.log.append("result turn")
        try:
            yield
        finally:
            self.log.append("collected")


class DurableChildWorkflowTests(unittest.IsolatedAsyncioTestCase):
    """On the durable /runs path (a child_slot is given) the child runs as the
    subagent_run DBOS child workflow, started and collected in the slot's
    turns, with a credential-free persisted input."""

    async def _run(self, make_start):
        """make_start(log) returns the DBOS.start_workflow_async stand-in; log
        records the slot protocol as run_subagent follows it."""
        import graph.subagent as subagent_module
        from dbos import DBOS

        workflow, log = object(), []
        with patch.object(subagent_module, "_subagent_workflow", workflow), \
                patch.object(DBOS, "start_workflow_async", make_start(log), create=True):
            out = await run_subagent(_parent_state(), GENERAL_PROFILE, "the task", 1, child_slot=_Slot(log))
        return out, log, workflow

    async def test_child_runs_as_a_child_workflow_with_no_credentials_in_its_input(self):
        seen = {}

        def make_start(log):
            class _Handle:
                async def get_result(self):
                    seen["log_at_result"] = list(log)
                    return {"content": "child report", "error": None}

            async def start(func, child_state, recursion_limit, name):
                seen.update(func=func, state=child_state, name=name, log_at_start=list(log))
                return _Handle()

            return start

        out, log, workflow = await self._run(make_start)

        self.assertEqual(out["content"], "child report")
        self.assertIs(seen["func"], workflow)
        self.assertEqual(seen["state"]["original_query"], "the task")
        self.assertEqual(seen["state"]["llm_credentials"], {})  # persisted input: no secret
        self.assertEqual(seen["name"], "general")
        self.assertEqual(seen["log_at_start"], ["start turn"])
        self.assertEqual(seen["log_at_result"], ["start turn", "started", "result turn"])
        self.assertEqual(log[-1], "collected")

    async def test_a_failed_start_is_a_value_and_ends_the_start_turn(self):
        def make_start(log):
            async def start(*args):
                raise RuntimeError("db down")

            return start

        out, log, _ = await self._run(make_start)

        self.assertEqual(out["content"], "")
        self.assertIn("db down", out["error"])
        self.assertEqual(log, ["start turn", "started"])

    async def test_a_cancelled_child_is_a_value(self):
        from dbos._error import DBOSAwaitedWorkflowCancelledError

        def make_start(log):
            class _Handle:
                async def get_result(self):
                    raise DBOSAwaitedWorkflowCancelledError("run_x-1")

            async def start(*args):
                return _Handle()

            return start

        out, log, _ = await self._run(make_start)

        self.assertEqual(out["content"], "")
        self.assertIn("DBOSAwaitedWorkflowCancelledError", out["error"])
        self.assertEqual(log[-1], "collected")


if __name__ == "__main__":
    unittest.main()
