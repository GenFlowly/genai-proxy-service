"""
Unit tests for graph.entitlements and where its gate applies.

Run with `python -m unittest tests.test_entitlements`.

Pinned here:

  * knowledge and memory search need both a vector DB and an embedding key;
    web search needs a web search key; a request without entitlements keeps
    every tool (voice, an older proxy)
  * _build_state, the choke point for chat, durable runs and voice, binds only
    the tools the customer can use, and keeps the entitlements in state
  * a subagent gets no tool its parent couldn't bind
"""
import unittest
from unittest.mock import patch

from langchain_core.messages import AIMessage

import graph.nodes.llm_node as llm_node_module
from graph.entitlements import can_search_vectors, can_search_web, entitled_tools
from graph.subagent import run_subagent
from models import Entitlements, RawData, RetrieveRequest
from routes.retrieve import _build_state

_TOOLS = ["search_knowledge_base", "search_memories", "web_search", "write_todos"]


def _entitlements(vector_db=True, embedding=True, web_search=True) -> dict:
    return {
        "is_vector_db_storing_enabled": vector_db,
        "is_embedding_creation_enabled": embedding,
        "is_web_search_enabled": web_search,
    }


class EntitledToolsTests(unittest.TestCase):
    def test_vector_search_needs_a_vector_db_and_an_embedding_key(self):
        self.assertTrue(can_search_vectors(_entitlements()))
        self.assertFalse(can_search_vectors(_entitlements(vector_db=False)))
        self.assertFalse(can_search_vectors(_entitlements(embedding=False)))
        self.assertEqual(
            entitled_tools(_TOOLS, _entitlements(embedding=False)), ["web_search", "write_todos"]
        )

    def test_web_search_needs_a_web_search_key(self):
        self.assertFalse(can_search_web(_entitlements(web_search=False)))
        self.assertEqual(
            entitled_tools(_TOOLS, _entitlements(web_search=False)),
            ["search_knowledge_base", "search_memories", "write_todos"],
        )

    def test_no_entitlements_keeps_every_tool(self):
        self.assertTrue(can_search_vectors(None))
        self.assertTrue(can_search_web(None))
        self.assertEqual(entitled_tools(_TOOLS, None), _TOOLS)


class BuildStateTests(unittest.TestCase):
    def _request(self, entitlements=None) -> RetrieveRequest:
        return RetrieveRequest(
            customer_id="cust-1",
            client="test",
            data_type="text",
            raw_data=RawData(query_data="hi"),
            llm_credentials={},
            memory_enabled=True,
            entitlements=entitlements,
        )

    def test_only_tools_the_customer_can_use_are_bound(self):
        state = _build_state(
            self._request(Entitlements(is_vector_db_storing_enabled=True, is_web_search_enabled=True)), {}, _TOOLS
        )

        self.assertEqual(state["builtin_tools"], ["web_search", "write_todos"])
        self.assertEqual(state["entitlements"], _entitlements(embedding=False))

    def test_a_request_without_entitlements_binds_every_tool(self):
        state = _build_state(self._request(), {}, _TOOLS)

        self.assertEqual(state["builtin_tools"], _TOOLS)
        self.assertIsNone(state["entitlements"])


class _RecorderLLM:
    async def ainvoke(self, messages):
        message = AIMessage(content="child answer")
        message.usage_metadata = {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}
        return message


class SubagentTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_child_gets_no_tool_its_parent_couldnt_bind(self):
        parent = {
            "customer_id": "cust-1",
            "client": "test",
            "llm_provider": "openai",
            "llm_model": "gpt-test",
            "llm_credentials": {"openai_api_key": "k"},
            "entitlements": _entitlements(vector_db=False, web_search=False),
        }
        profile = {"name": "researcher", "tools": ["web_search", "search_knowledge_base", "write_todos"]}
        with patch.object(
            llm_node_module, "_build_llm_and_structured", return_value=(_RecorderLLM(), None)
        ) as build, patch.object(llm_node_module, "credentials_for", return_value={}):
            out = await run_subagent(parent, profile, "Investigate the thing", 1)

        self.assertIsNone(out["error"])
        tool_specs = str(build.call_args.args[6])
        self.assertIn("write_todos", tool_specs)
        self.assertNotIn("web_search", tool_specs)
        self.assertNotIn("search_knowledge_base", tool_specs)


if __name__ == "__main__":
    unittest.main()
