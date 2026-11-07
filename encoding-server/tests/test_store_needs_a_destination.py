"""The store step embeds only when the text has somewhere to go: a customer
with no vector DB or no embedding key gets nothing embedded, and the message
ends there instead of failing into the dead-letter queue."""
import os
import unittest
from unittest import mock

os.environ.setdefault("AWS_REGION", "us-east-1")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

from encoding_library.utils.embedding_utils import EmbeddingKeyMissing  # noqa: E402
from encoding_library.utils.vector_db import VectorDBNotConfigured  # noqa: E402

from handlers import create_and_store_lambda  # noqa: E402


def batch():
    return {
        "data_type": "NOTE", "customer_id": "CU1", "client": "react-app",
        "raw_data": {"note_key": "nk-1", "created_at": "2026-11-05T00:00:00Z"},
        "data_chunks": ["Deduct the home office"],
        "model_type": "voyage", "model_name": "voyage-4-large", "request_id": "rid-1",
    }


class StoreNeedsADestinationTest(unittest.TestCase):

    def _store(self, vector_db, embedding_model):
        with mock.patch.object(create_and_store_lambda, "get_milvus_client", **vector_db), \
                mock.patch.object(create_and_store_lambda, "get_embedding_model_for_customer",
                                  **embedding_model) as get_encoder, \
                mock.patch.object(create_and_store_lambda, "create_embeddings") as embed, \
                mock.patch.object(create_and_store_lambda, "count") as counted:
            summary = create_and_store_lambda.handler(batch(), None)
        return summary, get_encoder, embed, counted

    def test_no_vector_db_embeds_nothing_and_ends_the_message(self):
        summary, get_encoder, embed, counted = self._store(
            vector_db={"side_effect": VectorDBNotConfigured("CU1")}, embedding_model={}
        )

        self.assertEqual(summary["inserted"], 0)
        get_encoder.assert_not_called()
        embed.assert_not_called()
        counted.assert_any_call("vector_store_skipped_total", data_type="NOTE", status="missing_vector_db")

    def test_no_embedding_key_embeds_nothing_and_ends_the_message(self):
        summary, _, embed, counted = self._store(
            vector_db={"return_value": mock.MagicMock()},
            embedding_model={"side_effect": EmbeddingKeyMissing("voyage")},
        )

        self.assertEqual(summary["inserted"], 0)
        embed.assert_not_called()
        counted.assert_any_call("vector_store_skipped_total", data_type="NOTE", status="missing_key")


if __name__ == "__main__":
    unittest.main()
