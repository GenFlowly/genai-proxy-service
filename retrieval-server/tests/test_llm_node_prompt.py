"""
Unit tests for the response generator's system-prompt assembly in llm_node.

Run with `python -m unittest tests.test_llm_node_prompt`.

The LLM call itself is stubbed out (_build_llm_and_structured is patched to
return a recorder), so these exercise only what reaches the model as the
SystemMessage: the persona, the current-date grounding, the web_search nudge,
and the tool-call preamble instruction that makes every vendor narrate why it
is calling a tool (reasoning models otherwise attach calls to an empty
message and the thinking panel shows bare signatures with no motive).
"""
import unittest
from unittest.mock import patch

from langchain_core.messages import AIMessage

import graph.nodes.llm_node as llm_node_module
from graph.nodes.llm_node import make_llm_node

_PREAMBLE_MARKER = "Whenever you decide to call one or more tools"
_WEB_SEARCH_MARKER = "use the web_search tool"


class _RecorderLLM:
    """Captures the messages the node sends; answers with fixed text."""

    def __init__(self):
        self.messages = None

    async def ainvoke(self, messages):
        self.messages = messages
        return AIMessage(content="ok")


def _state(**overrides) -> dict:
    state = {
        "customer_id": "cust-1",
        "client": "test",
        "data_type": "note",
        "request_source": "conversation",
        "original_query": "how many hotels does MGM own",
        "top_n": 5,
        "search_params": {},
        "similarity_threshold": 0.5,
        "llm_credentials": {},
        "llm_provider": "openai",
        "llm_model": "gpt-test",
        "conversation_history": [],
        "query_images": [],
        "tools": [],
        "query_tool_results": [],
        "builtin_tools": [],
        "node_configs": {
            "RESPONSE_GENERATOR": {
                "output_key": "generated_response",
                "input_template": "{query}",
            },
            "QUERY_ANALYZER": {
                "output_key": "query_intent",
                "input_template": "{query}",
                "system_prompt": "You are a query analyzer.",
            },
        },
        "request_system_prompt": "You are a helpful assistant.",
    }
    state.update(overrides)
    return state


async def _run(node_type: str, state: dict) -> str:
    """Run the node against the recorder; return the system prompt it sent."""
    recorder = _RecorderLLM()
    # credentials_for is evaluated at the call site even though the builder is
    # stubbed — patch it too so the test never touches DynamoDB.
    with patch.object(
        llm_node_module, "_build_llm_and_structured", return_value=(recorder, None)
    ), patch.object(llm_node_module, "credentials_for", return_value={}):
        await make_llm_node(node_type)(state)
    system = recorder.messages[0]
    content = system.content
    if isinstance(content, list):  # anthropic cache-control block form
        content = "".join(b.get("text", "") for b in content)
    return content


class ToolPreambleTests(unittest.IsolatedAsyncioTestCase):
    async def test_builtin_tools_add_the_preamble_instruction(self):
        prompt = await _run(
            "RESPONSE_GENERATOR", _state(builtin_tools=["web_search"])
        )
        self.assertIn(_PREAMBLE_MARKER, prompt)

    async def test_caller_defined_tools_also_add_it(self):
        tools = [{
            "name": "create_issue",
            "description": "Create an issue",
            "parameters": {"type": "object", "properties": {}},
        }]
        prompt = await _run("RESPONSE_GENERATOR", _state(tools=tools))
        self.assertIn(_PREAMBLE_MARKER, prompt)

    async def test_no_tools_means_no_preamble_instruction(self):
        prompt = await _run("RESPONSE_GENERATOR", _state())
        self.assertNotIn(_PREAMBLE_MARKER, prompt)

    async def test_web_search_nudge_still_present_alongside_the_preamble(self):
        prompt = await _run(
            "RESPONSE_GENERATOR", _state(builtin_tools=["web_search"])
        )
        self.assertIn(_WEB_SEARCH_MARKER, prompt)
        self.assertIn(_PREAMBLE_MARKER, prompt)
        # The nudge stays specific to web_search; the preamble applies to any
        # tool round — both belong in the same prompt, in that order.
        self.assertLess(prompt.index(_WEB_SEARCH_MARKER), prompt.index(_PREAMBLE_MARKER))

    async def test_non_response_nodes_are_untouched(self):
        # Pipeline nodes (analyzer/rewriter/ranker) never call tools — their
        # configured system_prompt must come through without the instruction.
        prompt = await _run(
            "QUERY_ANALYZER", _state(builtin_tools=["web_search"])
        )
        self.assertEqual(prompt, "You are a query analyzer.")

    async def test_persona_and_current_date_still_lead_the_prompt(self):
        prompt = await _run(
            "RESPONSE_GENERATOR", _state(builtin_tools=["web_search"])
        )
        self.assertTrue(prompt.startswith("You are a helpful assistant."))
        self.assertIn("The current date is", prompt)


if __name__ == "__main__":
    unittest.main()
