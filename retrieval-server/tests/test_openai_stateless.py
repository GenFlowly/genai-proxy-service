"""
OpenAI runs stateless: every call sets store=False, so OpenAI keeps no
Responses API state, and gpt-5 asks for its reasoning encrypted so a tool
round can hand it back with the history.

Run with `python -m unittest tests.test_openai_stateless`.

The last two tests pin langchain-openai behavior that store=False relies on
(requirements.lock.txt): a streamed reply keeps the encrypted reasoning from
the reasoning item's done event, and the next request replays that reasoning
without assistant message ids, which OpenAI can't resolve when nothing is
stored.
"""
import unittest

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_openai.chat_models import base as openai_base
from openai.types.responses import (
    ResponseOutputItemAddedEvent,
    ResponseOutputItemDoneEvent,
    ResponseReasoningItem,
)

from graph.llm_factory import get_llm


class OpenAIStatelessTests(unittest.TestCase):
    def test_every_openai_model_is_stateless(self):
        for model in ("gpt-5-mini", "gpt-4.1", "o4-mini"):
            llm = get_llm("openai", {"openai_api_key": "sk-test"}, model)
            self.assertIs(llm.store, False, model)
            self.assertFalse(llm.use_previous_response_id, model)

    def test_gpt5_asks_for_encrypted_reasoning_and_others_dont(self):
        gpt5 = get_llm("openai", {"openai_api_key": "sk-test"}, "gpt-5-mini")
        self.assertTrue(gpt5.use_responses_api)
        self.assertEqual(gpt5.include, ["reasoning.encrypted_content"])

        # include routes a model to the Responses API, so models that stay on
        # Chat Completions must not get it.
        self.assertIsNone(get_llm("openai", {"openai_api_key": "sk-test"}, "gpt-4.1").include)

    def test_a_streamed_reply_keeps_the_encrypted_reasoning(self):
        reasoning = ResponseReasoningItem(id="rs_1", type="reasoning", summary=[])
        added = ResponseOutputItemAddedEvent(
            type="response.output_item.added", item=reasoning, output_index=0, sequence_number=1
        )
        done = ResponseOutputItemDoneEvent(
            type="response.output_item.done",
            item=reasoning.model_copy(update={"encrypted_content": "ENC"}),
            output_index=0,
            sequence_number=2,
        )

        blocks = []
        index, output_index, sub_index = -1, -1, -1
        for event in (added, done):
            index, output_index, sub_index, chunk = openai_base._convert_responses_chunk_to_generation_chunk(
                event, index, output_index, sub_index
            )
            blocks.extend(chunk.message.content)

        self.assertIn("ENC", [b.get("encrypted_content") for b in blocks if b.get("type") == "reasoning"])

    def test_the_next_request_replays_encrypted_reasoning_without_message_ids(self):
        reply = AIMessage(
            content=[
                {"type": "reasoning", "id": "rs_1", "summary": [], "encrypted_content": "ENC"},
                {"type": "reasoning", "id": "rs_2", "summary": []},
                {"type": "text", "text": "Checking.", "id": "msg_1"},
                {"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "lookup",
                 "arguments": '{"q": "x"}'},
            ],
            tool_calls=[{"id": "call_1", "name": "lookup", "args": {"q": "x"}}],
        )
        items = openai_base._construct_responses_api_input(
            [HumanMessage("hi"), reply, ToolMessage("found", tool_call_id="call_1")], store=False
        )

        reasoning = [i for i in items if i.get("type") == "reasoning"]
        self.assertEqual([i.get("encrypted_content") for i in reasoning], ["ENC"])
        messages = [i for i in items if i.get("type") == "message" and i.get("role") == "assistant"]
        self.assertTrue(messages)
        self.assertTrue(all("id" not in m for m in messages))


if __name__ == "__main__":
    unittest.main()
