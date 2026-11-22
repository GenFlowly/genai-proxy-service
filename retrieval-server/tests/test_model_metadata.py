"""Unit tests for routes.model_metadata failure reporting (stdlib unittest).

A failed vendor fetch must say WHY (the vendor's own reason), flag a rejected
key as auth_failed so the proxy can mark it invalid, and never put the API key
in a URL (httpx logs every request URL).
Run: `python -m unittest tests.test_model_metadata`.
"""
import unittest

import httpx

from routes.model_metadata import VendorKey, _describe_failure, _fetch_for_vendor, _fetch_gemini


def _status_error(status, url, body):
    request = httpx.Request("GET", url)
    response = httpx.Response(status, json=body, request=request)
    return httpx.HTTPStatusError("boom", request=request, response=response)


class DescribeFailureTest(unittest.TestCase):
    def test_anthropic_401_keeps_vendor_reason_and_flags_auth(self):
        e = _status_error(
            401,
            "https://api.anthropic.com/v1/models?limit=100",
            {"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}},
        )
        message, auth_failed = _describe_failure(e)
        self.assertTrue(auth_failed)
        self.assertEqual(
            message, "401 Unauthorized from https://api.anthropic.com/v1/models: invalid x-api-key"
        )

    def test_403_is_auth_failure(self):
        e = _status_error(403, "https://api.openai.com/v1/models", {"error": {"message": "Missing scopes"}})
        self.assertTrue(_describe_failure(e)[1])

    def test_gemini_key_in_query_string_is_never_echoed(self):
        e = _status_error(
            400,
            "https://generativelanguage.googleapis.com/v1beta/models?key=AIzaSECRET&pageSize=200",
            {"error": {"code": 400, "message": "API key not valid.", "status": "INVALID_ARGUMENT"}},
        )
        message, auth_failed = _describe_failure(e)
        self.assertNotIn("AIzaSECRET", message)
        self.assertIn("API key not valid.", message)
        self.assertFalse(auth_failed)

    def test_server_error_is_not_auth_failure(self):
        e = _status_error(503, "https://api.openai.com/v1/models", {"error": "overloaded"})
        message, auth_failed = _describe_failure(e)
        self.assertFalse(auth_failed)
        self.assertEqual(message, "503 Service Unavailable from https://api.openai.com/v1/models: overloaded")

    def test_non_json_body_and_transport_errors(self):
        request = httpx.Request("GET", "https://api.openai.com/v1/models")
        e = httpx.HTTPStatusError(
            "boom", request=request, response=httpx.Response(502, text="<html>", request=request)
        )
        self.assertEqual(_describe_failure(e), ("502 Bad Gateway from https://api.openai.com/v1/models", False))
        self.assertEqual(_describe_failure(httpx.ConnectTimeout("timed out")), ("timed out", False))


class FetchForVendorTest(unittest.IsolatedAsyncioTestCase):
    async def test_rejected_key_comes_back_auth_failed(self):
        def handler(request):
            return httpx.Response(401, json={"error": {"message": "Incorrect API key provided: sk-****abcd"}})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            result = await _fetch_for_vendor(client, VendorKey(provider="openai", api_key="sk-x"), {})

        self.assertEqual(result.models, [])
        self.assertTrue(result.auth_failed)
        self.assertIn("Incorrect API key provided", result.error)

    async def test_gemini_key_travels_in_a_header_not_the_url(self):
        seen = []

        def handler(request):
            seen.append(request)
            return httpx.Response(200, json={"models": []})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await _fetch_gemini(client, "AIzaSECRET", {})

        self.assertEqual(seen[0].headers["x-goog-api-key"], "AIzaSECRET")
        self.assertNotIn("AIzaSECRET", str(seen[0].url))


if __name__ == "__main__":
    unittest.main()
