"""POST /purge-vectors (PDF plan 3.9): service-only, idempotent deletes of a
customer's conversation vectors or collections, with ids validated before
they reach a collection prefix or a filter expression."""
import json
import os
import unittest
from unittest import mock

os.environ.setdefault("AWS_REGION", "us-east-1")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

from handlers import purge_vectors_lambda  # noqa: E402

ALLOWED_CLIENT = "proxy-m2m-client"


class FakeMilvus:
    def __init__(self, collections):
        self.collections = {name: [] for name in collections}
        self.deletes = []
        self.dropped = []

    def list_collections(self):
        return list(self.collections)

    def delete(self, collection_name, filter):
        self.deletes.append((collection_name, filter))
        return {"delete_count": 2}

    def drop_collection(self, collection_name):
        self.dropped.append(collection_name)
        self.collections.pop(collection_name, None)


def event(body, gty="client-credentials", azp=ALLOWED_CLIENT):
    claims = {"sub": f"{azp}@clients", "azp": azp}
    if gty is not None:
        claims["gty"] = gty
    return {
        "requestContext": {"authorizer": {"jwt": {"claims": claims}}},
        "headers": {"authorization": "Bearer secret"},
        "body": body if isinstance(body, str) else json.dumps(body),
    }


CUSTOMER_COLLECTIONS = [
    "CU1A_conversation_voyage_4_large",
    "CU1A_conversation_all_MiniLM_L6_v2",
    "CU1A_notes_voyage_4_large",
    "CU1A_email_voyage_4_large",
    "CU1AB_conversation_voyage_4_large",  # another customer sharing a prefix
    "CU2_conversation_voyage_4_large",
    "System_instructions_voyage_4_large",
]


class PurgeVectorsTest(unittest.TestCase):

    def setUp(self):
        self.env = mock.patch.dict(os.environ, {"PURGE_ALLOWED_CLIENT_IDS": f"other, {ALLOWED_CLIENT}"})
        self.env.start()
        self.milvus = FakeMilvus(CUSTOMER_COLLECTIONS)
        self.client_patch = mock.patch.object(purge_vectors_lambda, "get_milvus_client", return_value=self.milvus)
        self.get_client = self.client_patch.start()

    def tearDown(self):
        self.client_patch.stop()
        self.env.stop()

    def call(self, body, **claims):
        response = purge_vectors_lambda.handler(event(body, **claims), None)
        return response["statusCode"], json.loads(response["body"])

    def test_conversation_vectors_are_deleted_from_the_customers_conversation_collections_only(self):
        status, body = self.call({"customerId": "CU1A", "conversationId": "3f2b8c1e-0000-4a5b-9c1d-123456789abc"})

        self.assertEqual(200, status)
        self.assertEqual(
            ["CU1A_conversation_all_MiniLM_L6_v2", "CU1A_conversation_voyage_4_large"], body["collections"]
        )
        self.assertEqual(4, body["deleted"])
        self.assertEqual(
            {('CU1A_conversation_all_MiniLM_L6_v2', 'conversation_key == "3f2b8c1e-0000-4a5b-9c1d-123456789abc"'),
             ('CU1A_conversation_voyage_4_large', 'conversation_key == "3f2b8c1e-0000-4a5b-9c1d-123456789abc"')},
            set(self.milvus.deletes),
        )
        self.assertEqual([], self.milvus.dropped)
        self.get_client.assert_called_once_with("CU1A")

    def test_dropping_takes_every_collection_of_the_customer_and_nothing_else(self):
        status, body = self.call({"customerId": "CU1A", "dropCollections": True})

        self.assertEqual(200, status)
        self.assertEqual(
            ["CU1A_conversation_all_MiniLM_L6_v2", "CU1A_conversation_voyage_4_large",
             "CU1A_email_voyage_4_large", "CU1A_notes_voyage_4_large"],
            body["dropped"],
        )
        self.assertIn("CU1AB_conversation_voyage_4_large", self.milvus.collections)
        self.assertIn("System_instructions_voyage_4_large", self.milvus.collections)

    def test_both_actions_are_idempotent(self):
        self.call({"customerId": "CU1A", "dropCollections": True})
        status, body = self.call({"customerId": "CU1A", "dropCollections": True})
        self.assertEqual((200, []), (status, body["dropped"]))

        status, body = self.call({"customerId": "CU9", "conversationId": "abc-123"})
        self.assertEqual(200, status)
        self.assertEqual(([], 0), (body["collections"], body["deleted"]))

    def test_user_tokens_and_unknown_clients_are_refused(self):
        for claims in ({"gty": None}, {"azp": "someone-else"}, {"gty": "password"}):
            status, _ = self.call({"customerId": "CU1A", "dropCollections": True}, **claims)
            self.assertEqual(403, status, claims)
        self.assertEqual([], self.milvus.dropped)
        self.get_client.assert_not_called()

    def test_everything_is_refused_until_a_client_is_allowed(self):
        with mock.patch.dict(os.environ, {"PURGE_ALLOWED_CLIENT_IDS": ""}):
            status, _ = self.call({"customerId": "CU1A", "dropCollections": True})
        self.assertEqual(403, status)
        self.get_client.assert_not_called()

    def test_ids_that_could_escape_the_prefix_or_the_filter_are_rejected(self):
        for body in (
            {"customerId": "", "dropCollections": True},
            {"customerId": "CU1_notes", "dropCollections": True},
            {"customerId": "System", "dropCollections": True},
            {"customerId": "public", "dropCollections": True},
            {"customerId": 7, "dropCollections": True},
            {"customerId": "CU1A", "conversationId": 'x" or conversation_key != "'},
            {"customerId": "CU1A", "conversationId": ""},
            {"customerId": "CU1A"},
            {"customerId": "CU1A", "conversationId": "abc", "dropCollections": True},
            {"customerId": "CU1A", "dropCollections": "yes"},
        ):
            status, _ = self.call(body)
            self.assertEqual(400, status, body)
        status, _ = self.call("not json")
        self.assertEqual(400, status)
        self.assertEqual([], self.milvus.deletes)
        self.assertEqual([], self.milvus.dropped)

    def test_a_vector_store_failure_is_a_500_without_details(self):
        self.milvus.drop_collection = mock.Mock(side_effect=RuntimeError("zilliz down: token=secret"))
        status, body = self.call({"customerId": "CU1A", "dropCollections": True})
        self.assertEqual(500, status)
        self.assertEqual({"error": "Internal server error"}, body)


if __name__ == "__main__":
    unittest.main()
