"""/delete-conversation-vectors: deleting one conversation removes its
chunks from the shared conversation collections, scoped to the customer, and
from that customer's legacy conversation collections, and nothing else."""
import unittest
from unittest.mock import patch

from fastapi import HTTPException

import routes.notes as notes_module
from encoding_library.utils.vector_db import VectorDBNotConfigured
from routes.notes import DeleteConversationVectorsRequest, delete_conversation_vectors


class _FakeMilvus:
    def __init__(self, collections, fail=False):
        self._collections = list(collections)
        self._fail = fail
        self.deletes = []

    def list_collections(self):
        return list(self._collections)

    def delete(self, collection_name, filter):
        if self._fail:
            raise RuntimeError("cluster unavailable")
        self.deletes.append((collection_name, filter))
        return {"delete_count": 2}


class DeleteConversationVectorsTests(unittest.IsolatedAsyncioTestCase):
    async def _run(self, client, conversation_key="conv-1"):
        with patch.object(notes_module, "get_milvus_client", return_value=client):
            return await delete_conversation_vectors(
                DeleteConversationVectorsRequest(customer_id="CU1", conversation_key=conversation_key)
            )

    async def test_deletes_the_conversation_from_conversation_collections_only(self):
        client = _FakeMilvus([
            "conversation_voyage_4_large", "notes_voyage_4_large", "CU1_conversation_old", "CU2_conversation_old",
        ])

        result = await self._run(client)

        self.assertEqual(
            [
                ("conversation_voyage_4_large", 'customer_id == "CU1" and (conversation_key == "conv-1")'),
                ("CU1_conversation_old", 'conversation_key == "conv-1"'),
            ],
            client.deletes,
        )
        self.assertEqual({"conversation_voyage_4_large": 2, "CU1_conversation_old": 2}, result["deleted"])

    async def test_quotes_in_the_key_cannot_widen_the_filter(self):
        client = _FakeMilvus(["conversation_voyage_4_large"])

        await self._run(client, conversation_key='x" or customer_id != "')

        self.assertIn('conversation_key == "x\\" or customer_id != \\""', client.deletes[0][1])

    async def test_no_vector_db_means_nothing_to_delete(self):
        with patch.object(notes_module, "get_milvus_client", side_effect=VectorDBNotConfigured("none")):
            result = await delete_conversation_vectors(
                DeleteConversationVectorsRequest(customer_id="CU1", conversation_key="conv-1")
            )

        self.assertEqual({"status": "success", "deleted": {}}, result)

    async def test_a_failure_is_an_error_so_the_caller_retries(self):
        with self.assertRaises(HTTPException) as raised:
            await self._run(_FakeMilvus(["conversation_voyage_4_large"], fail=True))

        self.assertEqual(500, raised.exception.status_code)

    async def test_both_ids_are_required(self):
        with self.assertRaises(HTTPException) as raised:
            await self._run(_FakeMilvus([]), conversation_key="")

        self.assertEqual(400, raised.exception.status_code)


if __name__ == "__main__":
    unittest.main()
