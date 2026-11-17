"""Daily Zilliz heartbeat: one real read per connected customer cluster, kept
out of the Cost and Usage rollup, with one customer's failure never stopping
the others."""
import os
import unittest
from unittest import mock

os.environ.setdefault("AWS_REGION", "us-east-1")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

from encoding_library.utils.vector_db import VectorDBNotConfigured  # noqa: E402
from handlers import zilliz_heartbeat_lambda  # noqa: E402


class FakeMilvus:
    def __init__(self, collections):
        self.collections = collections
        self.queries = []

    def list_collections(self, **kwargs):
        return list(self.collections)

    def query(self, **kwargs):
        self.queries.append(kwargs)
        return []


class FakeTable:
    def __init__(self, pages):
        self.pages = pages
        self.scans = []

    def scan(self, **kwargs):
        self.scans.append(kwargs)
        return self.pages[len(self.scans) - 1]


class FakeContext:
    def __init__(self, remaining_ms):
        self.remaining_ms = remaining_ms

    def get_remaining_time_in_millis(self):
        return self.remaining_ms


def table_of(*customer_ids):
    return FakeTable([{"Items": [{"customerId": c} for c in customer_ids]}])


class ZillizHeartbeatTest(unittest.TestCase):

    def run_handler(self, table, clients, context=None):
        record_usage_flags = []

        def get_client(customer_id, record_usage=True):
            record_usage_flags.append(record_usage)
            client = clients[customer_id]
            if isinstance(client, Exception):
                raise client
            return client

        with mock.patch.object(zilliz_heartbeat_lambda, "vector_db_table", table), \
                mock.patch.object(zilliz_heartbeat_lambda, "get_milvus_client", side_effect=get_client), \
                mock.patch.object(zilliz_heartbeat_lambda, "count") as count:
            result = zilliz_heartbeat_lambda.handler({}, context)
        return result, record_usage_flags, count

    def test_queries_one_row_of_a_shared_collection_scoped_to_the_customer(self):
        client = FakeMilvus(["notes_voyage_4_large", "CU1_notes_voyage_4_large", "conversation_voyage_4_large"])
        result, _, _ = self.run_handler(table_of("CU1"), {"CU1": client})

        self.assertEqual(result["statuses"], {"ok": 1})
        self.assertEqual(len(client.queries), 1)
        query = client.queries[0]
        self.assertEqual(query["collection_name"], "conversation_voyage_4_large")
        self.assertEqual(query["filter"], 'customer_id == "CU1"')
        self.assertEqual(query["limit"], 1)

    def test_calls_stay_out_of_the_usage_rollup(self):
        _, flags, _ = self.run_handler(table_of("CU1"), {"CU1": FakeMilvus(["notes_voyage_4_large"])})
        self.assertEqual(flags, [False])

    def test_cluster_without_shared_collections_only_lists(self):
        client = FakeMilvus(["CU1_notes_voyage_4_large"])
        result, _, _ = self.run_handler(table_of("CU1"), {"CU1": client})
        self.assertEqual(result["statuses"], {"no_collections": 1})
        self.assertEqual(client.queries, [])

    def test_one_failing_cluster_does_not_stop_the_rest(self):
        ok = FakeMilvus(["notes_voyage_4_large"])
        clients = {
            "CU1": RuntimeError("cluster suspended"),
            "CU2": VectorDBNotConfigured("CU2"),
            "CU3": ok,
        }
        result, _, count = self.run_handler(table_of("CU1", "CU2", "CU3"), clients)

        self.assertEqual(result["statuses"], {"error": 1, "not_configured": 1, "ok": 1})
        self.assertEqual(len(ok.queries), 1)
        count.assert_any_call("zilliz_heartbeat_total", 1, status="error")
        count.assert_any_call("zilliz_heartbeat_total", 1, status="ok")

    def test_scan_follows_pagination(self):
        table = FakeTable([
            {"Items": [{"customerId": "CU1"}], "LastEvaluatedKey": {"customerId": "CU1"}},
            {"Items": [{"customerId": "CU2"}]},
        ])
        clients = {"CU1": FakeMilvus([]), "CU2": FakeMilvus([])}
        result, _, _ = self.run_handler(table, clients)

        self.assertEqual(result["customers"], 2)
        self.assertEqual(table.scans[1]["ExclusiveStartKey"], {"customerId": "CU1"})

    def test_stops_starting_pings_when_lambda_time_runs_low(self):
        clients = {"CU1": FakeMilvus([]), "CU2": FakeMilvus([])}
        result, flags, _ = self.run_handler(table_of("CU1", "CU2"), clients, FakeContext(remaining_ms=5_000))
        self.assertEqual(result["statuses"], {"skipped": 2})
        self.assertEqual(flags, [])


if __name__ == "__main__":
    unittest.main()
