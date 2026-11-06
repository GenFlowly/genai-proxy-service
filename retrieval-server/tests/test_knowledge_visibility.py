"""The knowledge search only hands the model what the customer can still
see: a conversation or note hit is dropped once its row is gone (deleted),
archived or soft-deleted, a hit that can't be checked is dropped, and email
passes through. Chunks outlive their source until a delete reaches the
customer's vector DB, so this check is what keeps them out of prompts."""
import asyncio
import unittest
from unittest.mock import MagicMock, patch

from graph import visibility
from graph.visibility import visible_results


class _FakeDynamo:
    """batch_get_item over in-memory rows, keyed (table, customerId, id)."""

    def __init__(self, rows, unprocessed_first=False):
        self._rows = rows
        self._unprocessed_first = unprocessed_first
        self.requests = []

    def batch_get_item(self, RequestItems):
        self.requests.append(RequestItems)
        responses = {}
        for table, spec in RequestItems.items():
            if self._unprocessed_first:
                self._unprocessed_first = False
                return {"Responses": {}, "UnprocessedKeys": RequestItems}
            found = []
            for key in spec["Keys"]:
                item_id = key.get("conversationId") or key.get("noteKey")
                row = self._rows.get((table, key["customerId"], item_id))
                if row is not None:
                    found.append(row)
            responses[table] = found
        return {"Responses": responses, "UnprocessedKeys": {}}


def _hit(collection, **entity):
    return {"id": "x", "distance": 0.9, "entity": entity, "source_collection": collection}


class VisibleResultsTests(unittest.TestCase):
    def setUp(self):
        self.ddb = _FakeDynamo({
            ("Conversation", "CU1", "live"): {"conversationId": "live"},
            ("Conversation", "CU1", "archived"): {"conversationId": "archived", "archivedAt": "2026-10-01T00:00:00Z"},
            ("CustomerNotes", "CU1", "note-live"): {"noteKey": "note-live"},
            ("CustomerNotes", "CU1", "note-gone"): {"noteKey": "note-gone", "is_delete": True},
        })

    def test_drops_deleted_and_archived_conversations_and_deleted_notes(self):
        results = [
            _hit("conversation_voyage_4_large", conversation_key="live"),
            _hit("conversation_voyage_4_large", conversation_key="deleted"),
            _hit("conversation_voyage_4_large", conversation_key="archived"),
            _hit("notes_voyage_4_large", note_key="note-live"),
            _hit("notes_voyage_4_large", note_key="note-gone"),
            _hit("notes_voyage_4_large", note_key="note-deleted"),
            _hit("email_voyage_4_large", subject="Invoice"),
        ]

        kept = visible_results("CU1", results, dynamodb=self.ddb)

        self.assertEqual(
            [("conversation", "live"), ("notes", "note-live"), ("email", None)],
            [(r["source_collection"].split("_")[0], r["entity"].get("conversation_key") or r["entity"].get("note_key"))
             for r in kept],
        )

    def test_checks_rows_under_the_customer_with_consistent_reads(self):
        visible_results("CU1", [_hit("conversation_voyage_4_large", conversation_key="live")], dynamodb=self.ddb)

        spec = self.ddb.requests[0]["Conversation"]
        self.assertEqual([{"customerId": "CU1", "conversationId": "live"}], spec["Keys"])
        self.assertTrue(spec["ConsistentRead"])

    def test_another_customers_conversation_is_not_visible(self):
        kept = visible_results("CU2", [_hit("conversation_voyage_4_large", conversation_key="live")], dynamodb=self.ddb)

        self.assertEqual([], kept)

    def test_a_hit_without_its_key_cannot_be_checked_and_is_dropped(self):
        kept = visible_results("CU1", [_hit("conversation_voyage_4_large", title="no key")], dynamodb=self.ddb)

        self.assertEqual([], kept)

    def test_email_only_results_need_no_lookup(self):
        results = [_hit("email_voyage_4_large", subject="Invoice")]

        self.assertEqual(results, visible_results("CU1", results, dynamodb=self.ddb))
        self.assertEqual([], self.ddb.requests)

    def test_unprocessed_keys_are_retried(self):
        ddb = _FakeDynamo({("Conversation", "CU1", "live"): {"conversationId": "live"}}, unprocessed_first=True)

        with patch.object(visibility.time, "sleep"):
            kept = visible_results("CU1", [_hit("conversation_voyage_4_large", conversation_key="live")], dynamodb=ddb)

        self.assertEqual(1, len(kept))
        self.assertEqual(2, len(ddb.requests))

    def test_a_dynamodb_failure_raises_rather_than_returning_unchecked_hits(self):
        ddb = MagicMock()
        ddb.batch_get_item.side_effect = RuntimeError("throttled")

        with self.assertRaises(RuntimeError):
            visible_results("CU1", [_hit("notes_voyage_4_large", note_key="note-live")], dynamodb=ddb)


class SearchKnowledgeAppliesVisibilityTests(unittest.TestCase):
    def test_hits_are_filtered_before_the_top_n_cut_and_key_fields_are_requested(self):
        from graph.nodes import retrieval

        client = MagicMock()
        client.search.return_value = [[
            {"id": "a", "distance": 0.95, "entity": {"conversation_key": "deleted"}},
            {"id": "b", "distance": 0.90, "entity": {"conversation_key": "live"}},
        ]]
        seen = {}

        def keep_live(customer_id, results):
            seen["customer_id"] = customer_id
            return [r for r in results if r["entity"]["conversation_key"] == "live"]

        with (
            patch.object(retrieval, "get_milvus_client", return_value=client),
            patch.object(retrieval, "_discover_collections",
                         return_value={("voyage", "voyage-4-large"): ["conversation_voyage_4_large"]}),
            patch.object(retrieval, "customer_embedding_model", return_value=MagicMock()),
            patch.object(retrieval, "create_embeddings", return_value=[{"vector": [0.1, 0.2]}]),
            patch.object(retrieval, "visible_results", side_effect=keep_live),
        ):
            results = asyncio.run(retrieval.search_knowledge("CU1", "taxes", 1, 0.5, {}))

        self.assertEqual(["b"], [r["id"] for r in results])
        self.assertEqual("CU1", seen["customer_id"])
        fields = client.search.call_args.kwargs["output_fields"]
        self.assertIn("conversation_key", fields)
        self.assertIn("note_key", fields)


if __name__ == "__main__":
    unittest.main()
