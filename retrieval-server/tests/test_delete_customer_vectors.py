"""/delete-customer-vectors: account deletion's vector purge. It deletes the
customer's rows from every shared collection, drops only that customer's
legacy collections, and leaves other tenants' collections alone."""
import unittest
from unittest.mock import patch

from fastapi import HTTPException

import routes.notes as notes_module
from encoding_library.utils.vector_db import VectorDBNotConfigured
from routes.notes import DeleteCustomerVectorsRequest, delete_customer_vectors


class _FakeMilvus:
    def __init__(self, collections, fail_on=None):
        self._collections = list(collections)
        self._fail_on = fail_on
        self.deletes = []
        self.dropped = []

    def list_collections(self):
        return list(self._collections)

    def delete(self, collection_name, filter):
        if collection_name == self._fail_on:
            raise RuntimeError("cluster unavailable")
        self.deletes.append((collection_name, filter))
        return {"delete_count": 3}

    def drop_collection(self, collection_name):
        self.dropped.append(collection_name)


class DeleteCustomerVectorsTests(unittest.TestCase):
    def _run(self, client, customer_id="CU1"):
        with patch.object(notes_module, "get_milvus_client", return_value=client):
            return delete_customer_vectors(DeleteCustomerVectorsRequest(customer_id=customer_id))

    def test_deletes_the_customers_rows_from_every_shared_collection(self):
        client = _FakeMilvus([
            "conversation_voyage_4_large", "notes_voyage_4_large",
            "memory_voyage_4_large", "instructions_voyage_4_large", "email_voyage_4_large",
        ])

        result = self._run(client)

        self.assertEqual(result["status"], "success")
        self.assertEqual(len(client.deletes), 5)
        for _, expression in client.deletes:
            self.assertEqual(expression, 'customer_id == "CU1"')
        self.assertEqual(sum(result["deleted"].values()), 15)
        self.assertEqual(client.dropped, [])

    def test_a_data_type_limits_the_delete_to_that_type(self):
        client = _FakeMilvus([
            "conversation_voyage_4_large", "memory_voyage_4_large", "CU1_conversation_minilm", "CU1_notes_minilm",
        ])

        with patch.object(notes_module, "get_milvus_client", return_value=client):
            result = delete_customer_vectors(
                DeleteCustomerVectorsRequest(customer_id="CU1", data_type="conversation")
            )

        self.assertEqual([name for name, _ in client.deletes], ["conversation_voyage_4_large"])
        self.assertEqual(client.dropped, ["CU1_conversation_minilm"])
        self.assertEqual(result["deleted"], {"conversation_voyage_4_large": 3})

    def test_drops_only_this_customers_legacy_collections(self):
        client = _FakeMilvus(["CU1_notes_minilm", "CU1_memory", "CU10_notes_minilm", "CU2_notes_minilm", "unrelated"])

        result = self._run(client)

        self.assertEqual(client.dropped, ["CU1_notes_minilm", "CU1_memory"])
        self.assertEqual(result["dropped"], ["CU1_notes_minilm", "CU1_memory"])
        self.assertEqual(client.deletes, [])

    def test_no_vector_db_means_nothing_to_delete(self):
        with patch.object(notes_module, "get_milvus_client", side_effect=VectorDBNotConfigured("none")):
            result = delete_customer_vectors(DeleteCustomerVectorsRequest(customer_id="CU1"))

        self.assertEqual(result, {"status": "success", "deleted": {}, "dropped": []})

    def test_a_failure_is_an_error_so_the_caller_retries(self):
        client = _FakeMilvus(["notes_voyage_4_large"], fail_on="notes_voyage_4_large")

        with self.assertRaises(HTTPException) as raised:
            self._run(client)

        self.assertEqual(raised.exception.status_code, 500)

    def test_refuses_an_id_that_could_widen_the_legacy_prefix(self):
        for bad in ("", "CU1_", "CU*", "a/b", "x" * 65):
            with self.subTest(customer_id=bad):
                client = _FakeMilvus(["CU1_notes_minilm"])
                with self.assertRaises(HTTPException) as raised:
                    self._run(client, customer_id=bad)
                self.assertEqual(raised.exception.status_code, 400)
                self.assertEqual(client.dropped, [])


if __name__ == "__main__":
    unittest.main()
