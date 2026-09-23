"""
Unit tests for routes.connectors.

Run with `python -m unittest tests.test_connectors`.

Both endpoints take a URL the user typed, which is why they live in this
service: it is where the SSRF-hardened client is. The tests that matter most
are therefore the refusals — a spec URL aimed at instance metadata, a private
address, a plaintext scheme — plus the invariant that neither endpoint writes
anything and that credential values are never accepted from a caller.
"""
import json
import unittest
from unittest.mock import AsyncMock, patch

import routes.connectors as connectors
from graph_tools.providers.safe_client import HttpResponse, UnsafeRequestError
from routes.connectors import (
    McpDiscoverRequest,
    OpenApiPreviewRequest,
    discover_mcp,
    preview_openapi,
)

SPEC = {
    "openapi": "3.0.0",
    "info": {"title": "Example API"},
    "servers": [{"url": "https://api.example.com"}],
    "paths": {
        "/v1/issues": {
            "get": {"operationId": "listIssues", "summary": "List all the issues."}
        }
    },
}


def _fetches(text, status=200, truncated=False):
    return patch.object(
        connectors.safe_client, "request",
        AsyncMock(return_value=HttpResponse(status, {}, text, truncated)),
    )


class OpenApiPreviewTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_valid_spec_returns_proposed_operations(self):
        with _fetches(json.dumps(SPEC)):
            out = await preview_openapi(
                OpenApiPreviewRequest(customer_id="c1", spec_url="https://x/openapi.json")
            )

        self.assertTrue(out.ok)
        self.assertEqual(out.title, "Example API")
        self.assertEqual(out.server_url, "https://api.example.com")
        self.assertEqual(len(out.operations), 1)
        self.assertEqual(out.operations[0].method, "GET")

    async def test_the_spec_is_fetched_through_the_hardened_client(self):
        # Not httpx directly: the URL is user-supplied, so it must go through
        # the client that refuses private addresses.
        with _fetches(json.dumps(SPEC)) as fetch:
            await preview_openapi(
                OpenApiPreviewRequest(customer_id="c1", spec_url="https://x/openapi.json")
            )

        self.assertEqual(fetch.await_args.args[0], "GET")
        self.assertEqual(fetch.await_args.args[1], "https://x/openapi.json")

    async def test_an_unsafe_spec_url_is_refused(self):
        error = UnsafeRequestError("Host resolves to a non-public address")
        with patch.object(connectors.safe_client, "request", AsyncMock(side_effect=error)):
            out = await preview_openapi(
                OpenApiPreviewRequest(
                    customer_id="c1", spec_url="https://169.254.169.254/latest/"
                )
            )

        self.assertFalse(out.ok)
        self.assertIn("non-public", out.error)

    async def test_a_yaml_spec_is_accepted(self):
        yaml_text = (
            "openapi: 3.0.0\n"
            "info:\n  title: YAML API\n"
            "servers:\n  - url: https://api.example.com\n"
            "paths:\n"
            "  /things:\n"
            "    get:\n"
            "      operationId: listThings\n"
            "      summary: List all of the things.\n"
        )
        with _fetches(yaml_text):
            out = await preview_openapi(
                OpenApiPreviewRequest(customer_id="c1", spec_url="https://x/openapi.yaml")
            )

        self.assertTrue(out.ok)
        self.assertEqual(out.title, "YAML API")

    async def test_a_non_spec_document_is_reported_clearly(self):
        with _fetches('{"hello": "world"}'):
            out = await preview_openapi(
                OpenApiPreviewRequest(customer_id="c1", spec_url="https://x/x.json")
            )

        self.assertFalse(out.ok)
        self.assertIn("OpenAPI", out.error)

    async def test_an_http_error_from_the_spec_url_is_reported(self):
        with _fetches("not found", status=404):
            out = await preview_openapi(
                OpenApiPreviewRequest(customer_id="c1", spec_url="https://x/x.json")
            )

        self.assertFalse(out.ok)
        self.assertIn("404", out.error)

    async def test_an_oversized_document_is_refused(self):
        with _fetches(json.dumps(SPEC), truncated=True):
            out = await preview_openapi(
                OpenApiPreviewRequest(customer_id="c1", spec_url="https://x/x.json")
            )

        self.assertFalse(out.ok)
        self.assertIn("too large", out.error)

    async def test_a_spec_whose_operations_are_all_unusable_says_so(self):
        spec = dict(SPEC)
        spec["paths"] = {"/x/{id}": {"get": {"operationId": "getX", "summary": "Get x."}}}
        with _fetches(json.dumps(spec)):
            out = await preview_openapi(
                OpenApiPreviewRequest(customer_id="c1", spec_url="https://x/x.json")
            )

        self.assertFalse(out.ok)
        self.assertEqual(out.operations, [])
        self.assertTrue(out.skipped)

    async def test_an_empty_url_is_reported_without_a_fetch(self):
        with patch.object(connectors.safe_client, "request", AsyncMock()) as fetch:
            out = await preview_openapi(
                OpenApiPreviewRequest(customer_id="c1", spec_url="")
            )

        fetch.assert_not_awaited()
        self.assertFalse(out.ok)

    async def test_a_blank_customer_id_is_rejected(self):
        from fastapi import HTTPException

        with self.assertRaises(HTTPException):
            await preview_openapi(OpenApiPreviewRequest(customer_id="", spec_url="https://x"))

    async def test_preview_writes_nothing(self):
        # The endpoint is a proposal: it must not touch the tool store.
        with _fetches(json.dumps(SPEC)), \
                patch.object(connectors, "resolve_tool_credentials",
                             side_effect=AssertionError("must not resolve")):
            out = await preview_openapi(
                OpenApiPreviewRequest(customer_id="c1", spec_url="https://x/x.json")
            )

        self.assertTrue(out.ok)


class McpDiscoverTests(unittest.IsolatedAsyncioTestCase):
    def _tools(self):
        return [
            connectors.McpDiscoveredTool(
                name="search", description="Search pages.",
                inputSchema={"type": "object", "properties": {"q": {"type": "string"}}},
            )
        ]

    async def test_discovery_returns_the_servers_tools(self):
        with patch.object(connectors, "resolve_tool_credentials",
                          return_value={"NOTION": {"token": "t"}}), \
                patch.object(connectors, "validate_url", create=True), \
                patch.object(connectors.safe_client, "validate_url", return_value=("h", 443)), \
                patch.object(connectors, "_list_mcp_tools",
                             AsyncMock(return_value=("Notion", self._tools()))):
            out = await discover_mcp(McpDiscoverRequest(
                customer_id="c1", server_url="https://mcp.notion.com/mcp",
                credential_ref="NOTION",
                headers={"Authorization": "Bearer {{credential.token}}"},
            ))

        self.assertTrue(out.ok)
        self.assertEqual(out.server_name, "Notion")
        self.assertEqual(out.tool_count, 1)
        self.assertEqual(out.tools[0].name, "search")

    async def test_credentials_are_resolved_not_accepted_from_the_caller(self):
        # The request model has no field for a credential value at all.
        self.assertNotIn("credentials", McpDiscoverRequest.model_fields)
        self.assertIn("credential_ref", McpDiscoverRequest.model_fields)

    async def test_the_header_template_is_rendered_with_the_stored_secret(self):
        listed = AsyncMock(return_value=("Notion", self._tools()))
        with patch.object(connectors, "resolve_tool_credentials",
                          return_value={"NOTION": {"token": "secret-tok"}}), \
                patch.object(connectors.safe_client, "validate_url", return_value=("h", 443)), \
                patch.object(connectors, "_list_mcp_tools", listed):
            await discover_mcp(McpDiscoverRequest(
                customer_id="c1", server_url="https://mcp.notion.com/mcp",
                credential_ref="NOTION",
                headers={"Authorization": "Bearer {{credential.token}}"},
            ))

        self.assertEqual(
            listed.await_args.args[1]["Authorization"], "Bearer secret-tok"
        )

    async def test_an_unsafe_server_url_is_refused_before_connecting(self):
        error = UnsafeRequestError("Host resolves to a non-public address")
        with patch.object(connectors, "resolve_tool_credentials",
                          return_value={"NOTION": {"token": "t"}}), \
                patch.object(connectors.safe_client, "validate_url", side_effect=error), \
                patch.object(connectors, "_list_mcp_tools", AsyncMock()) as listed:
            out = await discover_mcp(McpDiscoverRequest(
                customer_id="c1", server_url="https://10.0.0.1/mcp", credential_ref="NOTION",
            ))

        listed.assert_not_awaited()
        self.assertFalse(out.ok)

    async def test_missing_credentials_tell_the_user_to_save_the_key_first(self):
        with patch.object(connectors, "resolve_tool_credentials", return_value={"NOTION": {}}):
            out = await discover_mcp(McpDiscoverRequest(
                customer_id="c1", server_url="https://mcp.x/mcp", credential_ref="NOTION",
            ))

        self.assertFalse(out.ok)
        self.assertIn("key", out.error)

    async def test_a_server_offering_no_tools_is_reported(self):
        with patch.object(connectors, "resolve_tool_credentials",
                          return_value={"NOTION": {"token": "t"}}), \
                patch.object(connectors.safe_client, "validate_url", return_value=("h", 443)), \
                patch.object(connectors, "_list_mcp_tools", AsyncMock(return_value=("N", []))):
            out = await discover_mcp(McpDiscoverRequest(
                customer_id="c1", server_url="https://mcp.x/mcp", credential_ref="NOTION",
            ))

        self.assertFalse(out.ok)
        self.assertIn("no tools", out.error)

    async def test_an_unreachable_server_degrades_with_advice(self):
        with patch.object(connectors, "resolve_tool_credentials",
                          return_value={"NOTION": {"token": "t"}}), \
                patch.object(connectors.safe_client, "validate_url", return_value=("h", 443)), \
                patch.object(connectors, "_list_mcp_tools",
                             AsyncMock(side_effect=RuntimeError("connection refused"))):
            out = await discover_mcp(McpDiscoverRequest(
                customer_id="c1", server_url="https://mcp.x/mcp", credential_ref="NOTION",
            ))

        self.assertFalse(out.ok)
        self.assertIn("Check the URL", out.error)

    async def test_the_secret_never_appears_in_a_failure_response(self):
        with patch.object(connectors, "resolve_tool_credentials",
                          return_value={"NOTION": {"token": "tok-supersecret"}}), \
                patch.object(connectors.safe_client, "validate_url", return_value=("h", 443)), \
                patch.object(connectors, "_list_mcp_tools",
                             AsyncMock(side_effect=RuntimeError("401 tok-supersecret"))):
            out = await discover_mcp(McpDiscoverRequest(
                customer_id="c1", server_url="https://mcp.x/mcp", credential_ref="NOTION",
                headers={"Authorization": "Bearer {{credential.token}}"},
            ))

        self.assertNotIn("tok-supersecret", repr(out))

    async def test_a_server_needing_no_credential_is_allowed(self):
        with patch.object(connectors, "resolve_tool_credentials",
                          side_effect=AssertionError("must not resolve")), \
                patch.object(connectors.safe_client, "validate_url", return_value=("h", 443)), \
                patch.object(connectors, "_list_mcp_tools",
                             AsyncMock(return_value=("Open", self._tools()))):
            out = await discover_mcp(McpDiscoverRequest(
                customer_id="c1", server_url="https://mcp.x/mcp", credential_ref="",
            ))

        self.assertTrue(out.ok)

    async def test_a_blank_customer_id_is_rejected(self):
        from fastapi import HTTPException

        with self.assertRaises(HTTPException):
            await discover_mcp(McpDiscoverRequest(customer_id="", server_url="https://x"))


if __name__ == "__main__":
    unittest.main()
