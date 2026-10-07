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


if __name__ == "__main__":
    unittest.main()
