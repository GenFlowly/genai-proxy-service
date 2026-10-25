"""
Unit tests for the request-agent execution path (routes.retrieve
.execute_agent_graph + runs._request_agent_run) and the /encode-memory route.

Run with `python -m unittest tests.test_request_agents`.

Pinned here:

  * variable rendering accepts BOTH dialects — {{name}} (authoring dialect,
    optional inner whitespace; what published instructions use) and {name} —
    replaced verbatim so JSON-valued variables are safe, with runtime
    {state_field} placeholders untouched
  * GENERATION configs are adapted to the llm_node contract and the response
    node's prompt is lifted into request_system_prompt
  * durable=true routes through runs.request_agent_run with credentials
    STRIPPED from the workflow input; a not-ready runtime degrades to the
    plain path (fail-safe)
  * _request_agent_run invokes the checkpointer-bound graph with
    thread_id=run_id and never passes request credentials into state
  * request-level thinking_level overrides node config on response generators
    only; pipeline nodes keep their node-level setting
  * /encode-memory embeds, creates the collection on first use (schema
    mirroring MemoryProcessor), and deletes-then-inserts so re-encodes never
    strand stale rows
"""
import json
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from langchain_core.messages import AIMessage

import graph.nodes.llm_node as llm_node_module
import routes.notes as notes_module
import routes.retrieve as retrieve_module
import runs as runs_module
from graph.nodes.llm_node import make_llm_node
from models import ExecuteAgentGraphRequest
from routes.notes import EncodeMemoryRequest, encode_memory
from routes.retrieve import (
    _build_agent_graph_state,
    _prepare_agent_node_configs,
    _render_agent_variables,
    execute_agent_graph,
)


def _generation_node(node_id="NOD1", config: dict | None = None) -> dict:
    return {
        "nodeId": node_id,
        "nodeType": "GENERATION",
        "config": json.dumps(config or {}),
    }


def _request(**overrides) -> ExecuteAgentGraphRequest:
    payload = {
        "graph_id": "GRP1",
        "customer_id": "cust-1",
        "request_source": "memory_extraction",
        "variables": {"content": "User: hello"},
        "llm_credentials": {"openai_api_key": "sk-secret"},
        "llm_provider": "openai",
        "llm_model": "gpt-5",
        "llm_max_tokens": 4000,
    }
    payload.update(overrides)
    return ExecuteAgentGraphRequest(**payload)


class RenderAgentVariablesTests(unittest.TestCase):
    def _render(self, template: str, variables: dict) -> str:
        config = {"input_template": template}
        _render_agent_variables({"NOD1": config}, variables)
        return config["input_template"]

    def test_double_brace_authoring_dialect(self):
        out = self._render("Content: {{content}} end", {"content": "X"})
        self.assertEqual(out, "Content: X end")

    def test_double_brace_with_inner_whitespace(self):
        out = self._render("Content: {{ content }} end", {"content": "X"})
        self.assertEqual(out, "Content: X end")

    def test_single_brace_graph_dialect(self):
        out = self._render("Content: {content} end", {"content": "X"})
        self.assertEqual(out, "Content: X end")

    def test_json_valued_variable_with_braces_is_safe(self):
        memories = '[{"memoryId": "MEM#1", "text": "Is named Neel"}]'
        out = self._render(
            "Existing: {{existingMemories}}", {"existingMemories": memories}
        )
        self.assertEqual(out, f"Existing: {memories}")

    def test_runtime_placeholders_left_for_the_node(self):
        out = self._render("{original_query} vs {{content}}", {"content": "X"})
        self.assertEqual(out, "{original_query} vs X")

    def test_renders_system_prompt_too_and_aliased_configs_once(self):
        config = {"system_prompt": "Rules for {{sourceType}}", "input_template": "{content}"}
        # Same dict aliased under nodeId AND nodeType, as _build_node_configs does
        _render_agent_variables(
            {"NOD1": config, "GENERATION": config},
            {"sourceType": "conversation", "content": "X"},
        )
        self.assertEqual(config["system_prompt"], "Rules for conversation")
        self.assertEqual(config["input_template"], "X")


class PrepareAgentNodeConfigsTests(unittest.TestCase):
    def test_generation_defaults_and_response_prompt_lift(self):
        nodes = [_generation_node(config={
            "system_prompt": "You extract memories from {{sourceType}}.",
            "input_template": "{{content}}",
        })]
        node_configs, response_prompt = _prepare_agent_node_configs(
            nodes, {"sourceType": "conversation", "content": "User: hi"}
        )
        config = node_configs["NOD1"]
        self.assertEqual(config["output_key"], "generated_response")
        self.assertEqual(config["response_format"], "text")
        self.assertFalse(config["include_conversation_history"])
        self.assertEqual(config["input_template"], "User: hi")
        self.assertEqual(response_prompt, "You extract memories from conversation.")

    def test_state_strips_nothing_but_marks_no_request_thinking(self):
        nodes = [_generation_node(config={"system_prompt": "p"})]
        node_configs, response_prompt = _prepare_agent_node_configs(nodes, {})
        state = _build_agent_graph_state(_request(), node_configs, response_prompt)
        self.assertEqual(state["request_system_prompt"], "p")
        self.assertIsNone(state["request_thinking_level"])
        self.assertEqual(state["llm_credentials"], {"openai_api_key": "sk-secret"})
        self.assertEqual(state["request_source"], "memory_extraction")


class _FakeGraph:
    def __init__(self, result=None):
        self.result = result or {"generated_response": "ok", "usage": {"total_tokens": 1}}
        self.ainvoke = AsyncMock(return_value=self.result)


_GRAPH_DATA = ({"graphId": "GRP1"}, [_generation_node(config={"system_prompt": "p"})])


class ExecuteAgentGraphRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_durable_dispatches_to_the_workflow_with_credentials_stripped(self):
        workflow = AsyncMock(return_value={"generated_response": "done", "error": None, "usage": {}})
        with (
            patch.object(retrieve_module, "get_graph_and_nodes_by_id", return_value=_GRAPH_DATA),
            patch.object(retrieve_module.durable_runtime, "is_ready", return_value=True),
            patch.object(runs_module, "request_agent_run", workflow),
        ):
            response = await execute_agent_graph(_request(durable=True))

        self.assertEqual(json.loads(response.body)["generated_response"], "done")
        run_id, run_input = workflow.await_args.args
        self.assertTrue(run_id.startswith("ra-"))
        self.assertEqual(run_input["llm_credentials"], {})
        self.assertEqual(run_input["graph_id"], "GRP1")

    async def test_durable_degrades_to_plain_when_runtime_not_ready(self):
        graph = _FakeGraph()
        workflow = AsyncMock()
        with (
            patch.object(retrieve_module, "get_graph_and_nodes_by_id", return_value=_GRAPH_DATA),
            patch.object(retrieve_module.durable_runtime, "is_ready", return_value=False),
            patch.object(runs_module, "request_agent_run", workflow),
            patch.object(retrieve_module, "get_or_build_graph", return_value=(graph, 25)),
        ):
            response = await execute_agent_graph(_request(durable=True))

        workflow.assert_not_awaited()
        graph.ainvoke.assert_awaited_once()
        self.assertEqual(json.loads(response.body)["generated_response"], "ok")

    async def test_non_durable_never_touches_the_workflow(self):
        graph = _FakeGraph()
        workflow = AsyncMock()
        with (
            patch.object(retrieve_module, "get_graph_and_nodes_by_id", return_value=_GRAPH_DATA),
            patch.object(retrieve_module.durable_runtime, "is_ready", return_value=True),
            patch.object(runs_module, "request_agent_run", workflow),
            patch.object(retrieve_module, "get_or_build_graph", return_value=(graph, 25)),
        ):
            await execute_agent_graph(_request(durable=False))

        workflow.assert_not_awaited()
        # The plain path still sends the request credentials through state
        state = graph.ainvoke.await_args.args[0]
        self.assertEqual(state["llm_credentials"], {"openai_api_key": "sk-secret"})


class RequestAgentRunTests(unittest.IsolatedAsyncioTestCase):
    async def test_runs_checkpointer_bound_graph_with_thread_id_and_no_credentials(self):
        graph = _FakeGraph({"generated_response": "learned", "error": None, "usage": {"total_tokens": 9}})
        run_input = _request().model_dump()
        run_input["llm_credentials"] = {"openai_api_key": "should-be-ignored"}

        with (
            patch.object(runs_module.durable_runtime, "get_checkpointer", return_value=object()),
            patch.object(runs_module, "get_graph_and_nodes_by_id", return_value=_GRAPH_DATA),
            patch.object(runs_module, "get_or_build_durable_graph", return_value=(graph, 25)) as build,
        ):
            summary = await runs_module._request_agent_run("ra-test-1", run_input)

        self.assertEqual(summary, {"generated_response": "learned", "error": None, "usage": {"total_tokens": 9}})
        state, = graph.ainvoke.await_args.args
        # Even a credential smuggled into the input never reaches checkpointed state
        self.assertEqual(state["llm_credentials"], {})
        cfg = graph.ainvoke.await_args.kwargs["config"]
        self.assertEqual(cfg["configurable"]["thread_id"], "ra-test-1")
        # The durable (checkpointer-bound) graph variant is what was built
        self.assertIs(build.call_args.args[3].__class__, object)

    async def test_requires_the_checkpointer(self):
        with patch.object(runs_module.durable_runtime, "get_checkpointer", return_value=None):
            with self.assertRaises(RuntimeError):
                await runs_module._request_agent_run("ra-test-2", _request().model_dump())


class _RecorderLLM:
    async def ainvoke(self, messages):
        return AIMessage(content="ok")


class RequestThinkingLevelTests(unittest.IsolatedAsyncioTestCase):
    """request_thinking_level beats node config on response generators only."""

    def _state(self, node_configs: dict, **overrides) -> dict:
        state = {
            "customer_id": "cust-1",
            "client": "test",
            "data_type": "note",
            "request_source": "conversation",
            "original_query": "q",
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
            "node_configs": node_configs,
            "request_system_prompt": "persona",
            "request_thinking_level": None,
        }
        state.update(overrides)
        return state

    async def _thinking_sent(self, node_type: str, state: dict):
        captured = {}

        def fake_build(*args, allow_thinking=False, thinking_level=None):
            captured["thinking_level"] = thinking_level
            return (_RecorderLLM(), None)

        with (
            patch.object(llm_node_module, "_build_llm_and_structured", side_effect=fake_build),
            patch.object(llm_node_module, "credentials_for", return_value={}),
        ):
            await make_llm_node(node_type)(state)
        return captured["thinking_level"]

    async def test_request_level_overrides_node_config_on_response_node(self):
        configs = {"RESPONSE_GENERATOR": {
            "output_key": "generated_response", "input_template": "{query}", "thinking_level": "low",
        }}
        sent = await self._thinking_sent(
            "RESPONSE_GENERATOR", self._state(configs, request_thinking_level="high")
        )
        self.assertEqual(sent, "high")

    async def test_node_config_is_the_fallback(self):
        configs = {"RESPONSE_GENERATOR": {
            "output_key": "generated_response", "input_template": "{query}", "thinking_level": "low",
        }}
        sent = await self._thinking_sent("RESPONSE_GENERATOR", self._state(configs))
        self.assertEqual(sent, "low")

    async def test_pipeline_nodes_ignore_the_request_level(self):
        configs = {"QUERY_ANALYZER": {
            "output_key": "query_intent", "input_template": "{query}",
            "system_prompt": "You are a query analyzer.",
        }}
        sent = await self._thinking_sent(
            "QUERY_ANALYZER", self._state(configs, request_thinking_level="high")
        )
        self.assertIsNone(sent)

    async def test_invalid_request_value_is_ignored(self):
        configs = {"RESPONSE_GENERATOR": {
            "output_key": "generated_response", "input_template": "{query}",
        }}
        sent = await self._thinking_sent(
            "RESPONSE_GENERATOR", self._state(configs, request_thinking_level="turbo")
        )
        self.assertIsNone(sent)


class _FakeMilvusForEncode:
    def __init__(self, has_collection: bool):
        self._has = has_collection
        self.created = None
        self.deleted = None
        self.inserted = None
        self.flushed = None

    def has_collection(self, name):
        return self._has

    def create_collection(self, collection_name, schema, index_params):
        self.created = (collection_name, schema, index_params)

    def delete(self, collection_name, filter):
        self.deleted = (collection_name, filter)

    def insert(self, collection_name, data):
        self.inserted = (collection_name, data)
        return {"insert_count": len(data)}

    def flush(self, collection_name):
        self.flushed = collection_name


class EncodeMemoryRouteTests(unittest.IsolatedAsyncioTestCase):
    def _request(self, **overrides) -> EncodeMemoryRequest:
        payload = {
            "customer_id": "cust-1",
            "memory_key": "MEM#abc",
            "memory_value": "Is named Neel.",
            "title": "[memory] profile",
            "created_at": "2026-10-10T00:00:00Z",
            "model_type": "voyage",
            "model_name": "voyage-4-large",
        }
        payload.update(overrides)
        return EncodeMemoryRequest(**payload)

    async def _run(self, req, has_collection: bool, vector=None):
        client = _FakeMilvusForEncode(has_collection)
        embeddings = [{"vector": vector if vector is not None else [0.1, 0.2], "text": req.memory_value}]
        with (
            patch.object(notes_module, "get_milvus_client", return_value=client),
            patch("graph.nodes.retrieval.customer_embedding_model", return_value=MagicMock()),
            patch("encoding_library.utils.embedding_utils.create_embeddings", return_value=embeddings),
        ):
            result = await encode_memory(req)
        return result, client

    async def test_creates_the_collection_on_first_use_with_the_mirrored_schema(self):
        result, client = await self._run(self._request(), has_collection=False)

        name, schema, _index = client.created
        self.assertEqual(name, "memory_voyage_4_large")
        field_names = {f.name for f in schema.fields}
        self.assertEqual(
            field_names,
            {"id", "vector", "note_value", "title", "memory_key", "client", "created_at", "customer_id"},
        )
        customer_field = next(f for f in schema.fields if f.name == "customer_id")
        self.assertTrue(customer_field.is_partition_key)
        self.assertIn('"model_name": "voyage-4-large"', schema.description)
        self.assertEqual(result["collection"], "memory_voyage_4_large")

    async def test_deletes_then_inserts_so_reencodes_are_idempotent(self):
        _, client = await self._run(self._request(), has_collection=True)

        self.assertIsNone(client.created)
        self.assertEqual(client.deleted[0], "memory_voyage_4_large")
        self.assertIn('memory_key == "MEM#abc"', client.deleted[1])
        # Shared collection: the delete must be scoped to this customer's rows.
        self.assertIn('customer_id == "cust-1"', client.deleted[1])
        _, data = client.inserted
        record = data[0]
        self.assertEqual(record["id"], "MEM#abc_0")
        self.assertEqual(record["customer_id"], "cust-1")
        self.assertEqual(record["note_value"], "Is named Neel.")
        self.assertEqual(record["memory_key"], "MEM#abc")
        self.assertEqual(record["created_at"], "2026-10-10T00:00:00Z")
        self.assertEqual(client.flushed, "memory_voyage_4_large")

    async def test_blank_fields_are_a_400(self):
        from fastapi import HTTPException

        with self.assertRaises(HTTPException) as ctx:
            await encode_memory(self._request(memory_value="   "))
        self.assertEqual(ctx.exception.status_code, 400)

    async def test_embedding_failure_is_a_500(self):
        from fastapi import HTTPException

        client = _FakeMilvusForEncode(True)
        with (
            patch.object(notes_module, "get_milvus_client", return_value=client),
            patch("graph.nodes.retrieval.customer_embedding_model", return_value=MagicMock()),
            patch("encoding_library.utils.embedding_utils.create_embeddings", return_value=[]),
        ):
            with self.assertRaises(HTTPException) as ctx:
                await encode_memory(self._request())
        self.assertEqual(ctx.exception.status_code, 500)
        self.assertIsNone(client.inserted)

    async def test_missing_embedding_key_is_a_409(self):
        from fastapi import HTTPException

        from encoding_library.utils.embedding_utils import EmbeddingKeyMissing

        client = _FakeMilvusForEncode(True)
        with (
            patch.object(notes_module, "get_milvus_client", return_value=client),
            patch(
                "graph.nodes.retrieval.customer_embedding_model",
                side_effect=EmbeddingKeyMissing("voyage"),
            ),
        ):
            with self.assertRaises(HTTPException) as ctx:
                await encode_memory(self._request())
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIsNone(client.inserted)


if __name__ == "__main__":
    unittest.main()
