import unittest
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from routes.debug_memory import router


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


class DebugMemoryEndpointTests(unittest.TestCase):
    def test_disabled_returns_404(self):
        with mock.patch.dict("os.environ", {}, clear=False):
            import os
            os.environ.pop("MEMORY_DEBUG_ENDPOINT", None)
            response = _client().get("/debug/memory")
        self.assertEqual(response.status_code, 404)

    def test_enabled_returns_snapshot(self):
        with mock.patch.dict("os.environ", {"MEMORY_DEBUG_ENDPOINT": "1"}):
            response = _client().get("/debug/memory?top=5")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertIn("gc", body)
        self.assertIn("traced", body)
        self.assertIn("top_allocations", body)
        self.assertLessEqual(len(body["top_allocations"]), 5)
        for entry in body["top_allocations"]:
            self.assertIn("site", entry)
            self.assertIn("size_bytes", entry)


if __name__ == "__main__":
    unittest.main()
