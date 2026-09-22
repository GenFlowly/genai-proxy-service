"""
Unit tests for graph_tools.providers.mcp_tool.

Run with `python -m unittest tests.test_mcp_tool`.

No MCP server is contacted: the one network call is patched. What is tested is
everything around it, which is where the decisions live — expanding a record
into namespaced tools from a PINNED manifest, refusing to guess when no manifest
has been approved, and rendering results without letting the server dictate
anything.
"""
import unittest
from unittest.mock import AsyncMock, patch

from graph_tools.base import ToolContext
from graph_tools.providers import mcp_tool
from graph_tools.providers.http_tool import ToolDefinitionError
from graph_tools.providers.mcp_tool import (
    McpTool,
    _flatten_content,
    mcp_tools_from_record,
)


class _Block:
    def __init__(self, text=None, type_="text"):
        if text is not None:
            self.text = text
        self.type = type_


class _Result:
    def __init__(self, content=None, is_error=False, structured_content=None):
        self.content = content
        self.is_error = is_error
        self.structured_content = structured_content


def _record(**overrides):
    record = {
        "name": "notion",
        "provider": "mcp",
        "description": "Notion workspace",
        "request": {
            "url": "https://mcp.notion.com/mcp",
            "headers": {"Authorization": "Bearer {{credential.token}}"},
        },
        "credentialRef": "NOTION",
        "discoveredTools": [
            {"name": "search", "description": "Search pages.",
             "inputSchema": {"type": "object", "properties": {"q": {"type": "string"}}}},
            {"name": "create-page", "description": "Create a page.",
             "inputSchema": {"type": "object", "properties": {}}},
        ],
    }
    record.update(overrides)
    return record


def _ctx(secrets=None):
    context = ToolContext(customer_id="cust-1", store=object())
    if secrets is not None:
        context.secrets = lambda ref: secrets.get(ref, {})
    return context


class ExpansionTests(unittest.TestCase):
    def test_one_record_expands_into_namespaced_tools(self):
        # Two servers may both expose "search"; the model must tell them apart.
        built = mcp_tools_from_record(_record())
        self.assertEqual(set(built), {"notion_search", "notion_create_page"})

    def test_remote_name_is_preserved_for_the_call(self):
        built = mcp_tools_from_record(_record())
        self.assertEqual(built["notion_create_page"].remote_name, "create-page")

    def test_description_and_schema_come_from_the_manifest(self):
        tool = mcp_tools_from_record(_record())["notion_search"]
        self.assertEqual(tool.description, "Search pages.")
        self.assertIn("q", tool.parameters["properties"])

    def test_spec_is_the_model_facing_shape(self):
        spec = mcp_tools_from_record(_record())["notion_search"].spec
        self.assertEqual(set(spec), {"name", "description", "parameters"})

    def test_no_pinned_manifest_yields_nothing(self):
        # Connected but not approved. Guessing would mean calling the server
        # during a request, which is exactly what pinning exists to avoid.
        self.assertEqual(mcp_tools_from_record(_record(discoveredTools=[])), {})
        self.assertEqual(mcp_tools_from_record(_record(discoveredTools=None)), {})

    def test_a_json_encoded_manifest_is_accepted(self):
        import json

        record = _record()
        record["discoveredTools"] = json.dumps(record["discoveredTools"])
        record["request"] = json.dumps(record["request"])
        self.assertEqual(set(mcp_tools_from_record(record)), {"notion_search", "notion_create_page"})

    def test_a_malformed_manifest_is_rejected(self):
        with self.assertRaises(ToolDefinitionError):
            mcp_tools_from_record(_record(discoveredTools="{not json"))

    def test_entries_without_a_name_are_skipped(self):
        built = mcp_tools_from_record(_record(discoveredTools=[{"description": "x"}]))
        self.assertEqual(built, {})

    def test_a_missing_or_odd_schema_becomes_an_empty_object_schema(self):
        built = mcp_tools_from_record(_record(discoveredTools=[{"name": "t"}]))
        self.assertEqual(built["notion_t"].parameters, {"type": "object", "properties": {}})

    def test_snake_case_schema_key_is_also_accepted(self):
        built = mcp_tools_from_record(_record(discoveredTools=[
            {"name": "t", "input_schema": {"type": "object", "properties": {"a": {}}}},
        ]))
        self.assertIn("a", built["notion_t"].parameters["properties"])


class RecordValidationTests(unittest.TestCase):
    def test_missing_name_is_rejected(self):
        with self.assertRaises(ToolDefinitionError):
            mcp_tools_from_record(_record(name=""))

    def test_missing_url_is_rejected(self):
        with self.assertRaises(ToolDefinitionError):
            mcp_tools_from_record(_record(request={"url": ""}))

    def test_plain_http_url_is_rejected(self):
        with self.assertRaises(ToolDefinitionError):
            mcp_tools_from_record(_record(request={"url": "http://mcp.example.com/mcp"}))

    def test_a_templated_server_url_is_rejected(self):
        # Same rule as the HTTP tier: the destination is fixed at definition.
        with self.assertRaises(ToolDefinitionError):
            mcp_tools_from_record(_record(request={"url": "https://{{args.host}}/mcp"}))

    def test_timeout_is_clamped(self):
        record = _record()
        record["request"]["timeoutSeconds"] = 10**6
        tool = mcp_tools_from_record(record)["notion_search"]
        self.assertLessEqual(tool.timeout, 120.0)


class ContentFlatteningTests(unittest.TestCase):
    def test_text_blocks_are_joined(self):
        self.assertEqual(_flatten_content([_Block("a"), _Block("b")]), "a\nb")

    def test_non_text_blocks_are_named_not_silently_dropped(self):
        # A model that receives an image should not conclude the call returned
        # nothing.
        out = _flatten_content([_Block(type_="image")])
        self.assertIn("image", out)

    def test_none_and_plain_strings(self):
        self.assertEqual(_flatten_content(None), "")
        self.assertEqual(_flatten_content("hi"), "hi")


class RunTests(unittest.IsolatedAsyncioTestCase):
    def _tool(self):
        return mcp_tools_from_record(_record())["notion_search"]

    async def test_happy_path_renders_headers_and_returns_text(self):
        tool = self._tool()
        call = AsyncMock(return_value=_Result([_Block("Found 3 pages")]))
        with patch.object(McpTool, "_call", call), \
                patch.object(mcp_tool, "validate_url", return_value=("mcp.notion.com", 443)):
            result = await tool.run({"q": "roadmap"}, _ctx({"NOTION": {"token": "secret-tok"}}))

        self.assertEqual(result.content, "Found 3 pages")
        headers = call.await_args.args[0]
        self.assertEqual(headers["Authorization"], "Bearer secret-tok")

    async def test_unconnected_server_tells_the_model_to_ask_for_setup(self):
        tool = self._tool()
        with patch.object(McpTool, "_call", AsyncMock()) as call:
            result = await tool.run({"q": "x"}, _ctx({}))

        call.assert_not_awaited()
        self.assertIn("not connected", result.content)

    async def test_an_unsafe_server_address_is_refused(self):
        tool = self._tool()
        error = mcp_tool.UnsafeRequestError("resolves to a non-public address")
        with patch.object(McpTool, "_call", AsyncMock()) as call, \
                patch.object(mcp_tool, "validate_url", side_effect=error):
            result = await tool.run({"q": "x"}, _ctx({"NOTION": {"token": "t"}}))

        call.assert_not_awaited()
        self.assertIn("could not be called", result.content)

    async def test_a_server_error_result_is_reported_not_raised(self):
        tool = self._tool()
        with patch.object(McpTool, "_call",
                          AsyncMock(return_value=_Result([_Block("rate limited")], is_error=True))), \
                patch.object(mcp_tool, "validate_url", return_value=("h", 443)):
            result = await tool.run({"q": "x"}, _ctx({"NOTION": {"token": "t"}}))

        self.assertIn("reported an error", result.content)
        self.assertIn("rate limited", result.content)

    async def test_a_transport_failure_degrades_rather_than_raising(self):
        tool = self._tool()
        with patch.object(McpTool, "_call", AsyncMock(side_effect=RuntimeError("closed"))), \
                patch.object(mcp_tool, "validate_url", return_value=("h", 443)):
            result = await tool.run({"q": "x"}, _ctx({"NOTION": {"token": "t"}}))

        self.assertIn("failed to reach", result.content)

    async def test_the_credential_never_appears_in_returned_content(self):
        tool = self._tool()
        with patch.object(McpTool, "_call", AsyncMock(side_effect=RuntimeError("boom"))), \
                patch.object(mcp_tool, "validate_url", return_value=("h", 443)):
            result = await tool.run({"q": "x"}, _ctx({"NOTION": {"token": "tok-supersecret"}}))

        self.assertNotIn("tok-supersecret", result.content)

    async def test_structured_content_is_used_when_there_are_no_text_blocks(self):
        tool = self._tool()
        with patch.object(McpTool, "_call",
                          AsyncMock(return_value=_Result([], structured_content={"count": 2}))), \
                patch.object(mcp_tool, "validate_url", return_value=("h", 443)):
            result = await tool.run({"q": "x"}, _ctx({"NOTION": {"token": "t"}}))

        self.assertIn("count", result.content)

    async def test_an_empty_result_says_so_rather_than_returning_nothing(self):
        tool = self._tool()
        with patch.object(McpTool, "_call", AsyncMock(return_value=_Result([]))), \
                patch.object(mcp_tool, "validate_url", return_value=("h", 443)):
            result = await tool.run({"q": "x"}, _ctx({"NOTION": {"token": "t"}}))

        self.assertIn("no content", result.content)

    async def test_a_huge_result_is_truncated(self):
        tool = self._tool()
        with patch.object(McpTool, "_call",
                          AsyncMock(return_value=_Result([_Block("x" * 100000)]))), \
                patch.object(mcp_tool, "validate_url", return_value=("h", 443)):
            result = await tool.run({"q": "x"}, _ctx({"NOTION": {"token": "t"}}))

        self.assertIn("[truncated]", result.content)
        self.assertLess(len(result.content), mcp_tool.MAX_RESULT_CHARS + 100)


class SeamTests(unittest.TestCase):
    """An mcp record must flow through the same loader as an http one."""

    def test_the_loader_recognises_the_mcp_provider(self):
        import graph.customer_tools as ct

        self.assertIn("mcp", ct._PROVIDERS)

    def test_build_tools_expands_an_mcp_record(self):
        import graph.customer_tools as ct

        built = ct.build_tools(_record())
        self.assertEqual(set(built), {"notion_search", "notion_create_page"})

    def test_a_bad_mcp_record_is_dropped_not_raised(self):
        import graph.customer_tools as ct

        self.assertEqual(ct.build_tools(_record(request={"url": "http://x/mcp"})), {})


if __name__ == "__main__":
    unittest.main()
