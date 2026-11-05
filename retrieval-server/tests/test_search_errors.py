"""Unified /search failures: a missing customer setting is a 409 that names
which setting, anything else a generic 500 — never an empty result list."""
import asyncio
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from encoding_library.utils.embedding_utils import EmbeddingKeyMissing
from encoding_library.utils.vector_db import VectorDBNotConfigured

from routes.search import SearchRequest, search


class SearchErrorTests(unittest.TestCase):
    def _search_raising(self, error: Exception) -> HTTPException:
        with patch("routes.search.get_milvus_client", side_effect=error):
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(search(SearchRequest(customer_id="CU-1", query="tests")))
        return caught.exception

    def test_no_vector_db_is_a_409_naming_the_setting(self):
        error = self._search_raising(VectorDBNotConfigured("CU-1"))
        self.assertEqual(error.status_code, 409)
        self.assertEqual(error.detail["error_type"], "vector_db_not_configured")
        self.assertIn("CU-1", error.detail["message"])

    def test_missing_embedding_key_is_a_409_naming_the_setting(self):
        error = self._search_raising(EmbeddingKeyMissing("voyage"))
        self.assertEqual(error.status_code, 409)
        self.assertEqual(error.detail["error_type"], "embedding_key_missing")

    def test_other_failures_are_a_500(self):
        error = self._search_raising(RuntimeError("zilliz down"))
        self.assertEqual(error.status_code, 500)
        self.assertEqual(error.detail, "Search failed")
