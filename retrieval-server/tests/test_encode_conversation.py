"""/encode-conversation: the proxy's retry path for an exchange whose pipeline
embed never landed. It writes the same rows as the encoding-server pipeline
and is idempotent, and a missing customer setting is a 409 so the retry stops."""
import unittest
from unittest.mock import MagicMock, patch

from fastapi import HTTPException

import routes.notes as notes_module
from encoding_library.utils.vector_db import VectorDBNotConfigured
from routes.notes import EncodeConversationRequest, encode_conversation


class _FakeMilvus:
    def __init__(self, has_collection: bool):
        self._has = has_collection
        self.created = None
        self.deleted = None
        self.inserted = None

    def has_collection(self, name):
        return self._has

    def create_collection(self, collection_name, schema, index_params):
        self.created = (collection_name, schema, index_params)

    def delete(self, collection_name, filter):
        self.deleted = (collection_name, filter)

    def insert(self, collection_name, data):
        self.inserted = (collection_name, data)
        return {"insert_count": len(data)}


def _request(**overrides) -> EncodeConversationRequest:
    payload = {
        "customer_id": "cust-1",
        "conversation_key": "conv-1",
        "message_key": "msg-2",
        "text": "User: what can I deduct?\nAssistant: Home office costs.",
        "created_at": "2026-11-05T00:00:00Z",
        "model_type": "voyage",
        "model_name": "voyage-4-large",
    }
    payload.update(overrides)
    return EncodeConversationRequest(**payload)


class EncodeConversationRouteTests(unittest.TestCase):
    def _run(self, req, has_collection=True, chunks=("chunk one", "chunk two")):
        client = _FakeMilvus(has_collection)
        embeddings = [{"vector": [0.1, 0.2], "text": c, "index": i} for i, c in enumerate(chunks)]
        with (
            patch.object(notes_module, "get_milvus_client", return_value=client),
            patch("graph.nodes.retrieval.customer_embedding_model", return_value=MagicMock()),
            patch("encoding_library.utils.model_registry.get_chunking_params", return_value=(1000, 200)),
            patch("encoding_library.utils.embedding_utils.create_chunks", return_value=list(chunks)),
            patch("encoding_library.utils.embedding_utils.create_embeddings", return_value=embeddings),
        ):
            result = encode_conversation(req)
        return result, client

    def test_writes_the_pipeline_rows_after_deleting_the_exchange(self):
        result, client = self._run(_request())

        self.assertEqual(client.deleted[0], "conversation_voyage_4_large")
        self.assertIn('message_key == "msg-2"', client.deleted[1])
        self.assertIn('customer_id == "cust-1"', client.deleted[1])
        name, data = client.inserted
        self.assertEqual(name, "conversation_voyage_4_large")
        self.assertEqual([r["id"] for r in data], ["msg-2_0", "msg-2_1"])
        self.assertEqual(data[1]["note_value"], "chunk two")
        self.assertEqual({r["conversation_key"] for r in data}, {"conv-1"})
        self.assertEqual({r["created_at"] for r in data}, {"2026-11-05T00:00:00Z"})
        self.assertEqual(result["chunks"], 2)

    def test_creates_the_collection_with_the_pipeline_schema(self):
        _, client = self._run(_request(), has_collection=False)

        _, schema, _ = client.created
        self.assertEqual(
            {f.name for f in schema.fields},
            {"id", "vector", "note_value", "title", "conversation_key", "message_key",
             "client", "created_at", "customer_id"},
        )

    def test_blank_text_is_a_400(self):
        with self.assertRaises(HTTPException) as ctx:
            encode_conversation(_request(text="  "))
        self.assertEqual(ctx.exception.status_code, 400)

    def test_no_vector_db_is_a_409_and_nothing_is_embedded(self):
        with (
            patch.object(notes_module, "get_milvus_client", side_effect=VectorDBNotConfigured("cust-1")),
            patch("graph.nodes.retrieval.customer_embedding_model", return_value=MagicMock()),
            patch("encoding_library.utils.model_registry.get_chunking_params", return_value=(1000, 200)),
            patch("encoding_library.utils.embedding_utils.create_chunks", return_value=["c"]),
            patch("encoding_library.utils.embedding_utils.create_embeddings",
                  return_value=[{"vector": [0.1], "text": "c"}]) as embed,
        ):
            with self.assertRaises(HTTPException) as ctx:
                encode_conversation(_request())
        self.assertEqual(ctx.exception.status_code, 409)
        embed.assert_not_called()

    def test_an_embedding_with_no_vector_is_a_500(self):
        with self.assertRaises(HTTPException) as ctx:
            client = _FakeMilvus(True)
            with (
                patch.object(notes_module, "get_milvus_client", return_value=client),
                patch("graph.nodes.retrieval.customer_embedding_model", return_value=MagicMock()),
                patch("encoding_library.utils.model_registry.get_chunking_params", return_value=(1000, 200)),
                patch("encoding_library.utils.embedding_utils.create_chunks", return_value=["c"]),
                patch("encoding_library.utils.embedding_utils.create_embeddings", return_value=[{"text": "c"}]),
            ):
                encode_conversation(_request())
        self.assertEqual(ctx.exception.status_code, 500)
        self.assertIsNone(client.inserted)
