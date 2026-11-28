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


class KnowledgeCitationTests(unittest.IsolatedAsyncioTestCase):
    """Citations from the model's own knowledge need their own reference lines
    in every answer, with or without tools: no tool result carries the rule."""

    _MARKER = "If you cite a claim that comes from your own knowledge"

    async def test_an_answer_without_tools_gets_the_rule(self):
        prompt = await _run("RESPONSE_GENERATOR", _state())
        self.assertIn(self._MARKER, prompt)
        self.assertIn("`[4]: Author(s), Title, Publication, Year`", prompt)

    async def test_an_answer_with_tools_gets_it_after_the_tool_sentences(self):
        prompt = await _run("RESPONSE_GENERATOR", _state(builtin_tools=["web_search"]))
        self.assertLess(prompt.index(_PREAMBLE_MARKER), prompt.index(self._MARKER))

    async def test_structured_output_has_no_reference_lines(self):
        schema = {"type": "object", "properties": {"x": {"type": "string"}}}
        prompt = await _run("RESPONSE_GENERATOR", _state(response_schema=schema))
        self.assertNotIn(self._MARKER, prompt)

    async def test_pipeline_nodes_never_get_it(self):
        prompt = await _run("QUERY_ANALYZER", _state())
        self.assertNotIn(self._MARKER, prompt)


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


class HarnessPromptTests(unittest.IsolatedAsyncioTestCase):
    """The harness prompt is agent-loop scaffolding, resolved from node config
    (data), composed BEFORE the customer persona — the persona says who the
    agent is, the harness says how it works."""

    def _configs(self, **generator_extra):
        return {
            "RESPONSE_GENERATOR": {
                "output_key": "generated_response",
                "input_template": "{query}",
                **generator_extra,
            },
        }

    async def test_harness_precedes_the_persona(self):
        prompt = await _run(
            "RESPONSE_GENERATOR",
            _state(node_configs=self._configs(harness_prompt="You are an autonomous agent.")),
        )
        self.assertTrue(prompt.startswith("You are an autonomous agent."))
        self.assertIn("You are a helpful assistant.", prompt)
        self.assertLess(
            prompt.index("autonomous agent"), prompt.index("helpful assistant")
        )

    async def test_no_harness_leaves_the_prompt_unchanged(self):
        prompt = await _run("RESPONSE_GENERATOR", _state())
        self.assertTrue(prompt.startswith("You are a helpful assistant."))

    async def test_spawn_agent_binding_lists_the_agent_types(self):
        state = _state(
            builtin_tools=["spawn_agent"],
            node_configs={
                **self._configs(),
                "TOOL_EXECUTOR": {
                    "tools": ["spawn_agent"],
                    "subagents": [{"name": "researcher", "description": "digs deep"}],
                },
            },
        )
        prompt = await _run("RESPONSE_GENERATOR", state)
        self.assertIn("Available agent types:", prompt)
        self.assertIn("- general:", prompt)
        self.assertIn("- researcher: digs deep", prompt)

    async def test_no_spawn_agent_means_no_listing(self):
        prompt = await _run("RESPONSE_GENERATOR", _state(builtin_tools=["web_search"]))
        self.assertNotIn("Available agent types:", prompt)


class TurnBudgetTests(unittest.IsolatedAsyncioTestCase):
    """Past max_turn_tokens the generator binds NO tools and is told to give
    its final answer — a clean exit for runaway loops, not a mid-turn abort."""

    def _state_with_budget(self, spent: int):
        return _state(
            builtin_tools=["web_search"],
            usage={"total_tokens": spent},
            node_configs={
                "RESPONSE_GENERATOR": {
                    "output_key": "generated_response",
                    "input_template": "{query}",
                    "max_turn_tokens": 1000,
                },
            },
        )

    async def _run_capturing(self, state):
        recorder = _RecorderLLM()
        with patch.object(
            llm_node_module, "_build_llm_and_structured", return_value=(recorder, None)
        ) as build, patch.object(llm_node_module, "credentials_for", return_value={}):
            await make_llm_node("RESPONSE_GENERATOR")(state)
        system = recorder.messages[0]
        content = system.content
        if isinstance(content, list):
            content = "".join(b.get("text", "") for b in content)
        tools_bound = build.call_args.args[5]
        return content, tools_bound

    async def test_exhausted_budget_unbinds_tools_and_forces_an_answer(self):
        prompt, tools_bound = await self._run_capturing(self._state_with_budget(spent=1500))
        self.assertFalse(tools_bound)
        self.assertIn("tool budget for this turn is exhausted", prompt)

    async def test_under_budget_binds_tools_normally(self):
        prompt, tools_bound = await self._run_capturing(self._state_with_budget(spent=100))
        self.assertTrue(tools_bound)
        self.assertNotIn("budget", prompt)


if __name__ == "__main__":
    unittest.main()


class StoppedReplyHistoryTests(unittest.IsolatedAsyncioTestCase):
    """A reply the user stopped before any text is kept on the conversation,
    so it reaches the history empty. Vendors reject an empty assistant turn,
    so it must not be replayed."""

    async def _messages(self, history: list) -> list:
        recorder = _RecorderLLM()
        with patch.object(
            llm_node_module, "_build_llm_and_structured", return_value=(recorder, None)
        ), patch.object(llm_node_module, "credentials_for", return_value={}):
            await make_llm_node("RESPONSE_GENERATOR")(_state(conversation_history=history))
        return recorder.messages

    async def test_an_empty_stopped_reply_is_not_replayed(self):
        history = [
            {"role": "user", "content": "write an essay"},
            {"role": "assistant", "content": ""},
            {"role": "user", "content": "shorter please"},
        ]
        messages = await self._messages(history)
        self.assertFalse(any(isinstance(m, AIMessage) for m in messages))
        self.assertTrue(all(m.content for m in messages))

    async def test_a_partial_stopped_reply_is_still_replayed(self):
        history = [
            {"role": "user", "content": "write an essay"},
            {"role": "assistant", "content": "The printing press began"},
            {"role": "user", "content": "go on"},
        ]
        messages = await self._messages(history)
        replies = [m for m in messages if isinstance(m, AIMessage)]
        self.assertEqual([m.content for m in replies], ["The printing press began"])
