"""Milvus connections must be reused per (endpoint, token) — pymilvus never
disconnects registered gRPC channels, so per-call construction retained one
channel per credential rotation forever — while capacity eviction closes the
evicted client (safe: every client is constructed through the cache, so an
evicted entry is its alias's only owner)."""
import pytest

import pymilvus

from encoding_library.utils import vector_db


class FakeMilvusClient:
    instances = []

    def __init__(self, uri, token, timeout, secure):
        self.uri = uri
        self.token = token
        self.closed = False
        FakeMilvusClient.instances.append(self)

    def close(self):
        self.closed = True

    def search(self, **kwargs):
        return ["hit"]


@pytest.fixture(autouse=True)
def fake_milvus(monkeypatch):
    FakeMilvusClient.instances = []
    vector_db._milvus_cache.clear()
    monkeypatch.setattr(pymilvus, "MilvusClient", FakeMilvusClient)
    monkeypatch.setattr(
        vector_db,
        "get_zilliz_credentials",
        lambda customer_id: (f"https://cluster-{customer_id}.zilliz.com", f"token-{customer_id}"),
    )
    yield
    vector_db._milvus_cache.clear()


def test_same_customer_reuses_underlying_client():
    first = vector_db.get_milvus_client("CU1")
    second = vector_db.get_milvus_client("CU1")
    assert first._target is second._target
    assert len(FakeMilvusClient.instances) == 1


def test_proxy_still_wraps_and_counts_per_customer():
    client = vector_db.get_milvus_client("CU1")
    assert client.search(collection_name="c") == ["hit"]


def test_rotated_token_builds_new_connection(monkeypatch):
    first = vector_db.get_milvus_client("CU1")
    monkeypatch.setattr(
        vector_db,
        "get_zilliz_credentials",
        lambda customer_id: ("https://cluster-CU1.zilliz.com", "token-rotated"),
    )
    second = vector_db.get_milvus_client("CU1")
    assert first._target is not second._target
    assert len(FakeMilvusClient.instances) == 2


def test_capacity_eviction_closes_oldest(monkeypatch):
    monkeypatch.setattr(vector_db, "_MILVUS_CACHE_MAX", 3)
    clients = [vector_db.get_milvus_client(f"CU{i}")._target for i in range(4)]
    assert len(vector_db._milvus_cache) == 3
    assert clients[0].closed is True
    assert all(c.closed is False for c in clients[1:])


def test_different_customers_different_clusters_not_shared():
    a = vector_db.get_milvus_client("CU1")
    b = vector_db.get_milvus_client("CU2")
    assert a._target is not b._target


def test_billable_ops_recorded_by_default(monkeypatch):
    recorded = []
    monkeypatch.setattr(vector_db, "_record_vector_db_op", lambda *args: recorded.append(args))
    vector_db.get_milvus_client("CU1").search(collection_name="c")
    assert recorded == [("CU1", "search", True)]


def test_record_usage_false_keeps_calls_out_of_the_rollup(monkeypatch):
    recorded = []
    monkeypatch.setattr(vector_db, "_record_vector_db_op", lambda *args: recorded.append(args))
    client = vector_db.get_milvus_client("CU1", record_usage=False)
    assert client.search(collection_name="c") == ["hit"]
    assert recorded == []
