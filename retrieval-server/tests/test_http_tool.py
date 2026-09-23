"""
Unit tests for graph_tools.providers.http_tool.

Run with `python -m unittest tests.test_http_tool`.

HttpTool interprets a stored record, so the tests fall into three groups:
what a valid definition is, what the rendered request may and may not become,
and how a response reaches the model. The first group is where a bad tool gets
rejected before it can ever run; the second is where a hostile argument gets
contained.
"""
import json
import unittest
from unittest.mock import AsyncMock, patch

from graph_tools.base import ToolContext
from graph_tools.providers import http_tool
from graph_tools.providers.http_tool import HttpTool, ToolDefinitionError, pin_origin
from graph_tools.providers.safe_client import HttpResponse
from graph_tools.providers.template import TemplateError


def _record(**overrides):
    record = {
        "name": "create_issue",
        "description": "Create an issue in the tracker.",
        "parameters": {
            "type": "object",
            "properties": {"title": {"type": "string"}, "id": {"type": "string"}},
            "required": ["title"],
        },
        "request": {
            "method": "POST",
            "url": "https://api.example.com/v1/issues",
            "headers": {"Authorization": "Bearer {{credential.api_key}}"},
            "body": {"title": "{{args.title}}"},
            "bodyType": "json",
        },
        "credentialRef": "TRACKER",
        "responseTransform": {"mode": "json_path", "path": "data.id"},
    }
    record.update(overrides)
    return record


def _ctx(secrets=None):
    context = ToolContext(customer_id="cust-1", store=object())
    if secrets is not None:
        context.secrets = lambda ref: secrets.get(ref, {})
    return context


class PinOriginTests(unittest.TestCase):
    def test_splits_origin_from_the_templated_remainder(self):
        origin, remainder = pin_origin("https://api.example.com/v1/{{args.id}}?x=1")
        self.assertEqual(origin, "https://api.example.com")
        self.assertIn("{{args.id}}", remainder)

    def test_keeps_a_nonstandard_port_in_the_origin(self):
        origin, _ = pin_origin("https://api.example.com:8443/v1")
        self.assertEqual(origin, "https://api.example.com:8443")

    def test_a_templated_host_is_rejected(self):
        # The property the whole tier rests on.
        with self.assertRaises(ToolDefinitionError):
            pin_origin("https://{{args.host}}/v1/x")

    def test_a_templated_scheme_is_rejected(self):
        with self.assertRaises(ToolDefinitionError):
            pin_origin("{{args.scheme}}://api.example.com/x")

    def test_plain_http_is_rejected(self):
        with self.assertRaises(ToolDefinitionError):
            pin_origin("http://api.example.com/x")

    def test_missing_host_is_rejected(self):
        with self.assertRaises(ToolDefinitionError):
            pin_origin("https:///x")

    def test_empty_url_is_rejected(self):
        with self.assertRaises(ToolDefinitionError):
            pin_origin("")


class DefinitionValidationTests(unittest.TestCase):
    def test_a_valid_record_builds(self):
        tool = HttpTool(_record())
        self.assertEqual(tool.name, "create_issue")
        self.assertEqual(tool.credential_ref, "TRACKER")
        self.assertEqual(tool.origin, "https://api.example.com")

    def test_json_encoded_attributes_are_accepted(self):
        # DynamoDB stores these as JSON strings.
        record = _record()
        record["parameters"] = json.dumps(record["parameters"])
        record["request"] = json.dumps(record["request"])
        record["responseTransform"] = json.dumps(record["responseTransform"])
        tool = HttpTool(record)
        self.assertEqual(tool.method, "POST")

    def test_missing_name_is_rejected(self):
        with self.assertRaises(ToolDefinitionError):
            HttpTool(_record(name=""))

    def test_missing_description_is_rejected(self):
        with self.assertRaises(ToolDefinitionError):
            HttpTool(_record(description="  "))

    def test_malformed_parameters_are_rejected(self):
        with self.assertRaises(ToolDefinitionError):
            HttpTool(_record(parameters={"type": "string"}))

    def test_invalid_json_attribute_is_rejected(self):
        with self.assertRaises(ToolDefinitionError):
            HttpTool(_record(parameters="{not json"))

    def test_disallowed_method_is_rejected(self):
        record = _record()
        record["request"]["method"] = "TRACE"
        with self.assertRaises(ToolDefinitionError):
            HttpTool(record)

    def test_unknown_body_type_is_rejected(self):
        record = _record()
        record["request"]["bodyType"] = "xml"
        with self.assertRaises(ToolDefinitionError):
            HttpTool(record)

    def test_json_path_without_a_path_is_rejected(self):
        with self.assertRaises(ToolDefinitionError):
            HttpTool(_record(responseTransform={"mode": "json_path"}))

    def test_a_placeholder_naming_an_undeclared_argument_is_rejected(self):
        # Otherwise the tool depends on an argument the model is never told about.
        record = _record()
        record["request"]["body"] = {"title": "{{args.nope}}"}
        with self.assertRaises(ToolDefinitionError) as ctx:
            HttpTool(record)
        self.assertIn("nope", str(ctx.exception))

    def test_max_chars_is_clamped(self):
        low = HttpTool(_record(responseTransform={"mode": "text", "maxChars": 1}))
        high = HttpTool(_record(responseTransform={"mode": "text", "maxChars": 10**9}))
        self.assertGreaterEqual(low.max_chars, 100)
        self.assertLessEqual(high.max_chars, http_tool.MAX_MAX_CHARS)

    def test_spec_is_the_model_facing_shape_only(self):
        spec = HttpTool(_record()).spec
        self.assertEqual(set(spec), {"name", "description", "parameters"})


class BuildRequestTests(unittest.TestCase):
    def test_renders_headers_and_body(self):
        tool = HttpTool(_record())
        prepared = tool.build_request({"title": "Bug"}, {"api_key": "sk-1"})

        self.assertEqual(prepared["url"], "https://api.example.com/v1/issues")
        self.assertEqual(prepared["headers"]["Authorization"], "Bearer sk-1")
        self.assertEqual(prepared["body"], {"title": "Bug"})

    def test_renders_a_path_argument(self):
        record = _record()
        record["request"]["url"] = "https://api.example.com/v1/issues/{{args.id}}"
        prepared = HttpTool(record).build_request({"title": "x", "id": "42"}, {"api_key": "k"})
        self.assertEqual(prepared["url"], "https://api.example.com/v1/issues/42")

    def test_a_hostile_path_argument_cannot_change_the_destination(self):
        record = _record()
        record["request"]["url"] = "https://api.example.com/v1/issues/{{args.id}}"
        tool = HttpTool(record)
        for hostile in [
            "../../../admin",
            "..%2f..%2fadmin",
            "x/../../y",
            "@evil.example.com",
        ]:
            prepared = tool.build_request({"title": "t", "id": hostile}, {"api_key": "k"})
            self.assertTrue(
                prepared["url"].startswith("https://api.example.com/"),
                f"{hostile} produced {prepared['url']}",
            )

    def test_an_absolute_url_argument_cannot_replace_the_destination(self):
        record = _record()
        record["request"]["url"] = "https://api.example.com/v1/{{args.id}}"
        prepared = HttpTool(record).build_request(
            {"title": "t", "id": "https://evil.example.com/steal"}, {"api_key": "k"}
        )
        self.assertTrue(prepared["url"].startswith("https://api.example.com/"))
        self.assertNotIn("//evil.example.com", prepared["url"])

    def test_query_parameters_render(self):
        record = _record()
        record["request"]["query"] = {"q": "{{args.title}}"}
        prepared = HttpTool(record).build_request({"title": "hello"}, {"api_key": "k"})
        self.assertEqual(prepared["query"], {"q": "hello"})

    def test_a_missing_credential_surfaces_as_a_template_error(self):
        tool = HttpTool(_record())
        with self.assertRaises(TemplateError):
            tool.build_request({"title": "x"}, {})


class ResponseTransformTests(unittest.TestCase):
    def _transform(self, record_overrides, text):
        tool = HttpTool(_record(**record_overrides))
        return tool.transform_response(HttpResponse(200, {}, text))

    def test_text_mode_returns_the_body(self):
        self.assertEqual(self._transform({"responseTransform": {"mode": "text"}}, "hello"), "hello")

    def test_json_mode_pretty_prints(self):
        out = self._transform({"responseTransform": {"mode": "json"}}, '{"a":1}')
        self.assertIn('"a": 1', out)

    def test_json_path_extracts_a_nested_value(self):
        out = self._transform(
            {"responseTransform": {"mode": "json_path", "path": "data.id"}},
            '{"data": {"id": "ISS-7"}}',
        )
        self.assertEqual(out, "ISS-7")

    def test_json_path_indexes_into_lists(self):
        out = self._transform(
            {"responseTransform": {"mode": "json_path", "path": "items.1.name"}},
            '{"items": [{"name": "a"}, {"name": "b"}]}',
        )
        self.assertEqual(out, "b")

    def test_a_missing_path_is_a_message_not_an_error(self):
        out = self._transform(
            {"responseTransform": {"mode": "json_path", "path": "data.missing"}},
            '{"data": {}}',
        )
        self.assertIn("did not contain", out)

    def test_invalid_json_falls_back_to_the_raw_body(self):
        out = self._transform({"responseTransform": {"mode": "json"}}, "not json at all")
        self.assertIn("not valid JSON", out)
        self.assertIn("not json at all", out)

    def test_long_output_is_truncated_and_says_so(self):
        out = self._transform(
            {"responseTransform": {"mode": "text", "maxChars": 100}}, "x" * 5000
        )
        self.assertIn("[truncated]", out)
        self.assertLess(len(out), 200)


class RunTests(unittest.IsolatedAsyncioTestCase):
    async def test_happy_path(self):
        tool = HttpTool(_record())
        response = HttpResponse(200, {}, '{"data": {"id": "ISS-1"}}')
        with patch.object(http_tool.safe_client, "request", AsyncMock(return_value=response)) as req:
            result = await tool.run({"title": "Bug"}, _ctx({"TRACKER": {"api_key": "sk-1"}}))

        self.assertEqual(result.content, "ISS-1")
        self.assertEqual(req.await_args.args[0], "POST")
        self.assertEqual(req.await_args.kwargs["headers"]["Authorization"], "Bearer sk-1")

    async def test_unconnected_tool_tells_the_model_to_ask_for_setup(self):
        tool = HttpTool(_record())
        with patch.object(http_tool.safe_client, "request", AsyncMock()) as req:
            result = await tool.run({"title": "x"}, _ctx({}))

        req.assert_not_awaited()
        self.assertIn("not connected", result.content)

    async def test_an_http_error_is_reported_with_its_status(self):
        tool = HttpTool(_record())
        response = HttpResponse(422, {}, '{"error": "title required"}')
        with patch.object(http_tool.safe_client, "request", AsyncMock(return_value=response)):
            result = await tool.run({"title": "x"}, _ctx({"TRACKER": {"api_key": "k"}}))

        self.assertIn("422", result.content)
        self.assertIn("title required", result.content)

    async def test_a_refused_destination_is_reported_not_raised(self):
        tool = HttpTool(_record())
        error = http_tool.safe_client.UnsafeRequestError("resolves to a non-public address")
        with patch.object(http_tool.safe_client, "request", AsyncMock(side_effect=error)):
            result = await tool.run({"title": "x"}, _ctx({"TRACKER": {"api_key": "k"}}))

        self.assertIn("could not be called", result.content)

    async def test_a_transport_failure_degrades_rather_than_raising(self):
        tool = HttpTool(_record())
        with patch.object(http_tool.safe_client, "request",
                          AsyncMock(side_effect=RuntimeError("connection reset"))):
            result = await tool.run({"title": "x"}, _ctx({"TRACKER": {"api_key": "k"}}))

        self.assertIn("failed to reach", result.content)

    async def test_a_missing_required_argument_is_reported_to_the_model(self):
        record = _record()
        record["request"]["body"] = {"title": "{{args.title}}", "id": "{{args.id}}"}
        tool = HttpTool(record)
        with patch.object(http_tool.safe_client, "request", AsyncMock()) as req:
            result = await tool.run({"title": "x"}, _ctx({"TRACKER": {"api_key": "k"}}))

        req.assert_not_awaited()
        self.assertIn("Could not build the request", result.content)

    async def test_the_credential_never_appears_in_returned_content(self):
        tool = HttpTool(_record())
        with patch.object(http_tool.safe_client, "request",
                          AsyncMock(side_effect=RuntimeError("boom"))):
            result = await tool.run({"title": "x"}, _ctx({"TRACKER": {"api_key": "sk-supersecret"}}))

        self.assertNotIn("sk-supersecret", result.content)

    async def test_a_tool_without_a_credential_ref_runs_without_one(self):
        tool = HttpTool(_record(credentialRef="", request={
            "method": "GET",
            "url": "https://api.example.com/v1/public",
            "bodyType": "json",
        }))
        response = HttpResponse(200, {}, '{"data": {"id": "ok"}}')
        with patch.object(http_tool.safe_client, "request", AsyncMock(return_value=response)):
            result = await tool.run({}, _ctx({}))

        self.assertEqual(result.content, "ok")


if __name__ == "__main__":
    unittest.main()
