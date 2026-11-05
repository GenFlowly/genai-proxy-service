"""Unified /search failures: a missing customer setting is a 409 that names
which setting, anything else a generic 500 — never an empty result list."""
import asyncio
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from encoding_library.utils.embedding_utils import EmbeddingKeyMissing
from encoding_library.utils.vector_db import VectorDBNotConfigured

from routes.search import SearchRequest, search


def _search_raising(error: Exception) -> HTTPException:
    with patch("routes.search.get_milvus_client", side_effect=error):
        with pytest.raises(HTTPException) as caught:
            asyncio.run(search(SearchRequest(customer_id="CU-1", query="tests")))
    return caught.value


def test_no_vector_db_is_a_409_naming_the_setting():
    error = _search_raising(VectorDBNotConfigured("CU-1"))
    assert error.status_code == 409
    assert error.detail["error_type"] == "vector_db_not_configured"
    assert "CU-1" in error.detail["message"]


def test_missing_embedding_key_is_a_409_naming_the_setting():
    error = _search_raising(EmbeddingKeyMissing("voyage"))
    assert error.status_code == 409
    assert error.detail["error_type"] == "embedding_key_missing"


def test_other_failures_are_a_500():
    error = _search_raising(RuntimeError("zilliz down"))
    assert error.status_code == 500
    assert error.detail == "Search failed"
