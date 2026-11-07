"""
Unit tests for memory scope and usage logging in graph.nodes.memory and
graph.memory_tool.

Run with `python -m unittest tests.test_memory_scope`.

Pinned here:

  * a memory applies in Profile (every conversation) or in its projects, each
    with its own kind; rows from before placements read as Profile
  * the MEMORY node and search_memories only ever see Profile memories plus
    the conversation's project's
  * every memory sent to the model is logged once per reply: a usage row keyed
    by the reply plus the hit counter, in one transaction, so a retried call
    for the same reply can't count twice
  * the write reaches DynamoDB with a numeric hit counter and string keys
    (MEM-008: typed values given to the resource's client were sent as maps,
    so every usage write failed)
  * usage logging runs off the event loop, and a failure never breaks the turn
  * search_memories embeds the query for the CALLER (MEM-002: it used to call
    _embed_query with the wrong arguments and fail every time)
"""
import asyncio
import json
import unittest
from unittest.mock import MagicMock, patch

import boto3

from graph.nodes import memory as memory_mod
from graph.nodes.memory import kind_here, memory
from graph.memory_tool import SearchMemoriesTool
from graph_tools.base import ToolContext

_CONTEXT = {
    "project_id": "PRJa",
    "conversation_id": "CONV1",
    "response_message_id": "MSG9",
    "turn_started_at": "2026-11-05T10:42:00Z",
}
_COLLECTIONS = {("model-type", "model-name"): ["memory_m"]}


def _mem(key: str, text: str, kind: str = "CORE", placements: dict | None = None) -> dict:
    item = {"memoryId": key, "kind": kind, "text": text, "updatedAt": "2026-10-01T12:00:00Z"}
    if placements is not None:
        item["placements"] = placements
    return item


def _hit(key: str, score: float) -> dict:
    return {"id": key, "distance": score, "entity": {"memory_key": key}}


class _FakeMilvus:
    def __init__(self, hits: list[dict]):
        self._hits = hits

    def search(self, **kwargs):
        return [self._hits]


_MEMORIES = [
    _mem("MEM#legacy", "Works as an engineer."),
    _mem("MEM#profile", "Lives in Lisbon.", placements={"PROFILE": "CORE"}),
    _mem("MEM#here", "Report is due Dec 12.", placements={"PRJa": "CORE", "PRJb": "EPISODIC"}),
    _mem("MEM#hereEpisodic", "Survey has 420 responses.", placements={"PRJa": "EPISODIC"}),
    _mem("MEM#elsewhere", "Launch plan is secret.", placements={"PRJb": "CORE"}),
    _mem("MEM#elsewhereEpisodic", "Pricing uses Van Westendorp.", placements={"PRJb": "EPISODIC"}),
]


class KindHereTests(unittest.TestCase):
    def test_profile_applies_everywhere_and_projects_only_inside(self):
        shared = {"placements": {"PRJa": "CORE", "PRJb": "EPISODIC"}}
        self.assertEqual(kind_here({"kind": "EPISODIC"}, None), "EPISODIC")
        self.assertEqual(kind_here({"placements": {"PROFILE": "CORE"}}, "PRJz"), "CORE")
        self.assertEqual(kind_here(shared, "PRJa"), "CORE")
        self.assertEqual(kind_here(shared, "PRJb"), "EPISODIC")
        self.assertIsNone(kind_here(shared, "PRJc"))
        self.assertIsNone(kind_here(shared, None))


class MemoryNodeScopeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        memory_mod._memory_cache.clear()
        memory_mod._collection_cache.clear()

    async def _run(self, context, hits=()):
        state = {
            "customer_id": "cust-1", "memory_enabled": True, "original_query": "when is the report due?",
            "node_configs": {}, "model_type": None, "model_name": None, "memory_context": context,
        }
        recorded = MagicMock()
        with (
            patch.object(memory_mod, "_get_cached_memories", return_value=_MEMORIES),
            patch.object(memory_mod, "_milvus_client", return_value=_FakeMilvus(list(hits))),
            patch.object(memory_mod, "_memory_collections", return_value=_COLLECTIONS),
            patch.object(memory_mod, "_embed_query", return_value=[0.1, 0.2]),
            patch.object(memory_mod, "record_usage", recorded),
        ):
            result = await memory("NODE1")(state)
        return result, recorded

    async def test_a_project_conversation_gets_profile_and_that_project_only(self):
        hits = [_hit("MEM#hereEpisodic", 0.9), _hit("MEM#elsewhereEpisodic", 0.95)]
        result, recorded = await self._run(_CONTEXT, hits)

        block = result["memories_block"]
        for text in ("Works as an engineer.", "Lives in Lisbon.", "Report is due Dec 12.", "Survey has 420 responses."):
            self.assertIn(text, block)
        self.assertNotIn("Launch plan is secret.", block)
        self.assertNotIn("Van Westendorp", block)
        self.assertEqual(result["scratch"]["memory_stats"], {"core": 3, "recalled": 1})

        context, customer_id, used, source = recorded.call_args.args
        self.assertEqual((context, customer_id, source), (_CONTEXT, "cust-1", "node"))
        self.assertEqual(
            sorted(used),
            sorted([("MEM#legacy", "core"), ("MEM#profile", "core"), ("MEM#here", "core"),
                    ("MEM#hereEpisodic", "recalled")]),
        )

    async def test_without_vector_search_only_core_memories_apply_and_nothing_is_embedded(self):
        state = {
            "customer_id": "cust-1", "memory_enabled": True, "original_query": "when is the report due?",
            "node_configs": {}, "model_type": None, "model_name": None, "memory_context": _CONTEXT,
            "entitlements": {"is_vector_db_storing_enabled": True, "is_embedding_creation_enabled": False},
        }
        embed = MagicMock(return_value=[0.1, 0.2])
        milvus = MagicMock()
        with (
            patch.object(memory_mod, "_get_cached_memories", return_value=_MEMORIES),
            patch.object(memory_mod, "_milvus_client", milvus),
            patch.object(memory_mod, "_memory_collections", return_value=_COLLECTIONS),
            patch.object(memory_mod, "_embed_query", embed),
            patch.object(memory_mod, "record_usage", MagicMock()),
        ):
            result = await memory("NODE1")(state)

        self.assertIn("Lives in Lisbon.", result["memories_block"])
        self.assertEqual(result["scratch"]["memory_stats"]["recalled"], 0)
        embed.assert_not_called()
        milvus.assert_not_called()

    async def test_a_conversation_outside_projects_gets_profile_only(self):
        result, recorded = await self._run({**_CONTEXT, "project_id": None})

        block = result["memories_block"]
        self.assertIn("Lives in Lisbon.", block)
        self.assertNotIn("Report is due Dec 12.", block)
        self.assertEqual(sorted(u for u, _ in recorded.call_args.args[2]), ["MEM#legacy", "MEM#profile"])

    async def test_without_a_context_only_profile_applies(self):
        result, _ = await self._run(None)

        self.assertNotIn("Report is due Dec 12.", result["memories_block"])


class _FakeTransactions:
    def __init__(self, error=None):
        self.calls = []
        self._error = error

    def transact_write_items(self, **kwargs):
        self.calls.append(kwargs["TransactItems"])
        if self._error:
            raise self._error


def _client_error(code: str) -> Exception:
    error = Exception(code)
    error.response = {"Error": {"Code": code}}
    return error


class UsageWriteTests(unittest.TestCase):
    def _write(self, client, used):
        dynamodb = MagicMock()
        dynamodb.meta.client = client
        with patch.object(memory_mod, "_get_dynamodb", return_value=dynamodb), patch.object(memory_mod, "count") as count:
            memory_mod._write_usage("cust-1", _CONTEXT, used, "node")
        return count

    def test_each_memory_gets_a_reply_keyed_row_and_a_hit_in_one_transaction(self):
        client = _FakeTransactions()

        count = self._write(client, [("MEM#u1", "core"), ("MEM#u2", "recalled")])

        put, update = client.calls[0]
        item = put["Put"]["Item"]
        self.assertEqual(item["memoryId"], "MEMUSE#u1#2026-11-05T10:42:00Z#MSG9")
        self.assertEqual(item["conversationId"], "CONV1")
        self.assertEqual(item["how"], "core")
        self.assertEqual(item["projectId"], "PRJa")
        self.assertEqual(put["Put"]["ConditionExpression"], "attribute_not_exists(memoryId)")
        self.assertEqual(update["Update"]["Key"]["memoryId"], "MEM#u1")
        self.assertIn("ADD hitCount :one", update["Update"]["UpdateExpression"])
        self.assertEqual(update["Update"]["ConditionExpression"], "attribute_exists(memoryId)")
        self.assertEqual(len(client.calls), 2)
        count.assert_called_once_with("memory_usage_recorded_total", 2, source="node")

    def test_a_reply_already_counted_is_skipped_quietly(self):
        count = self._write(_FakeTransactions(_client_error("TransactionCanceledException")), [("MEM#u1", "core")])

        count.assert_not_called()

    def test_other_failures_are_counted_and_never_raise(self):
        count = self._write(_FakeTransactions(_client_error("ProvisionedThroughputExceededException")), [("MEM#u1", "core")])

        count.assert_called_once_with("memory_usage_write_failure_total", source="node")


class _Sent(Exception):
    pass


class UsageWireFormatTests(unittest.TestCase):
    def test_the_hit_counter_reaches_dynamodb_as_a_number(self):
        resource = boto3.resource(
            "dynamodb", region_name="us-east-1", aws_access_key_id="test", aws_secret_access_key="test"
        )
        sent = []

        def capture(params, **_):
            sent.append(json.loads(params["body"]))
            raise _Sent()

        resource.meta.client.meta.events.register("before-call.dynamodb.TransactWriteItems", capture)
        with patch.object(memory_mod, "_get_dynamodb", return_value=resource), patch.object(memory_mod, "count"):
            memory_mod._write_usage("cust-1", _CONTEXT, [("MEM#u1", "core")], "node")

        put, update = sent[0]["TransactItems"]
        self.assertEqual(put["Put"]["Item"]["memoryId"], {"S": "MEMUSE#u1#2026-11-05T10:42:00Z#MSG9"})
        self.assertEqual(put["Put"]["Item"]["customerId"], {"S": "cust-1"})
        self.assertEqual(update["Update"]["Key"]["memoryId"], {"S": "MEM#u1"})
        self.assertEqual(update["Update"]["ExpressionAttributeValues"][":one"], {"N": "1"})
        self.assertEqual(update["Update"]["ExpressionAttributeValues"][":at"], {"S": "2026-11-05T10:42:00Z"})


class RecordUsageTests(unittest.IsolatedAsyncioTestCase):
    async def test_runs_off_the_event_loop(self):
        writer = MagicMock()
        with patch.object(memory_mod, "_write_usage", writer):
            memory_mod.record_usage(_CONTEXT, "cust-1", [("MEM#u1", "core")], "node")
            for _ in range(50):
                if writer.called:
                    break
                await asyncio.sleep(0.01)
        writer.assert_called_once_with("cust-1", _CONTEXT, [("MEM#u1", "core")], "node")

    async def test_nothing_is_logged_without_a_context_or_memories(self):
        writer = MagicMock()
        with patch.object(memory_mod, "_write_usage", writer):
            memory_mod.record_usage(None, "cust-1", [("MEM#u1", "core")], "node")
            memory_mod.record_usage(_CONTEXT, "cust-1", [], "node")
            await asyncio.sleep(0.02)
        writer.assert_not_called()


class SearchMemoriesScopeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        memory_mod._memory_cache.clear()
        memory_mod._collection_cache.clear()

    async def test_searches_for_the_caller_within_scope_and_logs_the_hits(self):
        context = ToolContext(customer_id="cust-1", store=None)
        context.runtime.update({"memory_enabled": True, "memory_context": _CONTEXT})
        hits = [_hit("MEM#hereEpisodic", 0.9), _hit("MEM#elsewhere", 0.95), _hit("MEM#profile", 0.6)]
        recorded = MagicMock()
        with (
            patch.object(memory_mod, "_get_cached_memories", return_value=_MEMORIES),
            patch.object(memory_mod, "_milvus_client", return_value=_FakeMilvus(hits)),
            patch.object(memory_mod, "_memory_collections", return_value=_COLLECTIONS),
            # autospec enforces the real signature: the MEM-002 call failed it.
            patch.object(memory_mod, "_embed_query", autospec=True, return_value=[0.1, 0.2]) as embed,
            patch.object(memory_mod, "record_usage", recorded),
        ):
            result = await SearchMemoriesTool().run({"query": "survey size"}, context)

        embed.assert_called_once_with("cust-1", "survey size", "model-type", "model-name")
        self.assertIn("Survey has 420 responses.", result.content)
        self.assertIn("Lives in Lisbon.", result.content)
        self.assertNotIn("Launch plan is secret.", result.content)
        recorded.assert_called_once_with(
            _CONTEXT, "cust-1", [("MEM#hereEpisodic", "search"), ("MEM#profile", "search")], "tool"
        )


if __name__ == "__main__":
    unittest.main()
