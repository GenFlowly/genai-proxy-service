"""
Unit tests for routes.tools (the dry-run endpoint).

Run with `python -m unittest tests.test_tools_dry_run`.

The property worth defending hardest: the echoed request must never carry a
real credential value. The endpoint achieves that by rendering the request
twice — once with the real credentials for the wire, once with masked ones for
display — so masking cannot be defeated by a template that transforms the
secret (base64, a prefix, a signature) in a way substring-scrubbing would miss.
"""
import unittest
from unittest.mock import AsyncMock, patch

import routes.tools as tools_route
from graph_tools.providers.safe_client import HttpResponse, UnsafeRequestError
from routes.tools import DryRunRequest, dry_run

SECRET = "sk-super-secret-value"


def _tool(**overrides):
    tool = {
        "name": "search_tracker",
        "description": "Search the tracker for issues.",
        "parameters": {"type": "object", "properties": {"q": {"type": "string"}}},
        "request": {
            "method": "GET",
            "url": "https://api.example.com/v1/search",
            "headers": {"Authorization": "Bearer {{credential.api_key}}"},
            "query": {"q": "{{args.q}}"},
        },
        "credentialRef": "TRACKER",
        "responseTransform": {"mode": "json_path", "path": "data.0.title"},
    }
    tool.update(overrides)
    return tool


def _creds(values=None):
    return patch.object(
        tools_route, "resolve_tool_credentials",
        return_value={"TRACKER": values if values is not None else {"api_key": SECRET}},
    )


def _responds(response):
    return patch.object(tools_route.safe_client, "request", AsyncMock(return_value=response))


class MaskingTests(unittest.IsolatedAsyncioTestCase):
    async def test_the_echoed_request_never_contains_the_secret(self):
        response = HttpResponse(200, {}, '{"data": [{"title": "Found it"}]}')
        with _creds(), _responds(response):
            out = await dry_run(DryRunRequest(customer_id="c1", tool=_tool(), args={"q": "x"}))

        self.assertNotIn(SECRET, repr(out.request))
        self.assertIn("Bearer", out.request.headers["Authorization"])

    async def test_masking_survives_a_transformed_secret(self):
        # A template that wraps the secret would defeat substring scrubbing.
        tool = _tool()
        tool["request"]["headers"] = {"X-Auth": "prefix-{{credential.api_key}}-suffix"}
        response = HttpResponse(200, {}, '{"data": [{"title": "ok"}]}')
        with _creds(), _responds(response):
            out = await dry_run(DryRunRequest(customer_id="c1", tool=tool, args={"q": "x"}))

        self.assertNotIn(SECRET, out.request.headers["X-Auth"])
        self.assertIn("prefix-", out.request.headers["X-Auth"])

    async def test_the_real_request_still_carries_the_real_secret(self):
        response = HttpResponse(200, {}, '{"data": [{"title": "ok"}]}')
        with _creds(), _responds(response) as sent:
            await dry_run(DryRunRequest(customer_id="c1", tool=_tool(), args={"q": "x"}))

        self.assertEqual(sent.await_args.kwargs["headers"]["Authorization"], f"Bearer {SECRET}")

    async def test_the_secret_does_not_leak_through_an_error_path(self):
        with _creds(), patch.object(
            tools_route.safe_client, "request",
            AsyncMock(side_effect=RuntimeError("connection reset")),
        ):
            out = await dry_run(DryRunRequest(customer_id="c1", tool=_tool(), args={"q": "x"}))

        self.assertNotIn(SECRET, repr(out))


class ThreePanelTests(unittest.IsolatedAsyncioTestCase):
    """The three things a dry run must show, each catching a different mistake."""

    async def test_a_successful_run_returns_all_three(self):
        response = HttpResponse(200, {}, '{"data": [{"title": "Found it"}]}')
        with _creds(), _responds(response):
            out = await dry_run(DryRunRequest(customer_id="c1", tool=_tool(), args={"q": "x"}))

        self.assertTrue(out.ok)
        self.assertEqual(out.request.method, "GET")
        self.assertEqual(out.request.query, {"q": "x"})
        self.assertEqual(out.response.status_code, 200)
        self.assertIn("Found it", out.response.body)
        self.assertEqual(out.model_sees, "Found it")

    async def test_a_call_that_succeeds_but_yields_nothing_useful_is_visible(self):
        # The silent failure the gate exists to catch: HTTP 200, useless result.
        response = HttpResponse(200, {}, '{"data": []}')
        with _creds(), _responds(response):
            out = await dry_run(DryRunRequest(customer_id="c1", tool=_tool(), args={"q": "x"}))

        self.assertTrue(out.ok)
        self.assertIn("did not contain", out.model_sees)

    async def test_an_upstream_error_reports_the_status_and_body(self):
        response = HttpResponse(401, {}, '{"error": "bad token"}')
        with _creds(), _responds(response):
            out = await dry_run(DryRunRequest(customer_id="c1", tool=_tool(), args={"q": "x"}))

        self.assertFalse(out.ok)
        self.assertEqual(out.response.status_code, 401)
        self.assertIn("bad token", out.response.body)
        self.assertIn("401", out.error)


class FailureTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_bad_definition_is_reported_inline_not_raised(self):
        with _creds():
            out = await dry_run(DryRunRequest(customer_id="c1", tool=_tool(description=""), args={}))

        self.assertFalse(out.ok)
        self.assertIsNotNone(out.error)
        self.assertIsNone(out.request)

    async def test_a_templated_host_is_rejected(self):
        tool = _tool()
        tool["request"]["url"] = "https://{{args.q}}/v1"
        with _creds():
            out = await dry_run(DryRunRequest(customer_id="c1", tool=tool, args={"q": "evil.com"}))

        self.assertFalse(out.ok)
        self.assertIn("scheme or host", out.error)

    async def test_missing_credentials_tell_the_user_to_connect_first(self):
        with _creds({}):
            out = await dry_run(DryRunRequest(customer_id="c1", tool=_tool(), args={"q": "x"}))

        self.assertFalse(out.ok)
        self.assertIn("Connect the tool's key", out.error)

    async def test_a_missing_argument_is_reported_with_the_request_absent(self):
        with _creds():
            out = await dry_run(DryRunRequest(customer_id="c1", tool=_tool(), args={}))

        self.assertFalse(out.ok)
        self.assertIn("args.q", out.error)

    async def test_an_unsafe_destination_is_refused_but_still_shows_the_request(self):
        with _creds(), patch.object(
            tools_route.safe_client, "request",
            AsyncMock(side_effect=UnsafeRequestError("resolves to a non-public address")),
        ):
            out = await dry_run(DryRunRequest(customer_id="c1", tool=_tool(), args={"q": "x"}))

        self.assertFalse(out.ok)
        self.assertIsNotNone(out.request)
        self.assertIn("non-public", out.error)

    async def test_a_tool_without_a_credential_ref_needs_no_credentials(self):
        tool = _tool(credentialRef="")
        tool["request"]["headers"] = {}
        response = HttpResponse(200, {}, '{"data": [{"title": "ok"}]}')
        with patch.object(tools_route, "resolve_tool_credentials",
                          side_effect=AssertionError("should not resolve")), _responds(response):
            out = await dry_run(DryRunRequest(customer_id="c1", tool=tool, args={"q": "x"}))

        self.assertTrue(out.ok)

    async def test_a_blank_customer_id_is_rejected(self):
        from fastapi import HTTPException

        with self.assertRaises(HTTPException):
            await dry_run(DryRunRequest(customer_id="", tool=_tool(), args={}))


if __name__ == "__main__":
    unittest.main()
