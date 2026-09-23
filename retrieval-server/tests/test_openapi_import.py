"""
Unit tests for graph_tools.providers.openapi.

Run with `python -m unittest tests.test_openapi_import`.

The parser is a pure translator — no network, no storage — so it can be tested
against whole documents. Two themes run through these tests.

First, an operation that cannot be represented honestly must be SKIPPED with a
reason the user can read, never imported half-built. A tool that fails at call
time with nothing explaining why is worse than a tool that was never offered.

Second, the records it emits must satisfy the same rules a hand-written tool
does, because they go through the same validator and the same executor. In
particular the destination is literal and every {{args.x}} names a declared
parameter — an imported tool gets no exemption from the properties the whole
tier rests on.
"""
import unittest

from graph_tools.providers.http_tool import HttpTool
from graph_tools.providers.openapi import (
    MAX_OPERATIONS,
    SpecError,
    operations_from_spec,
    tool_name_for,
)


def _spec(paths=None, **overrides):
    spec = {
        "openapi": "3.0.0",
        "info": {"title": "Example API"},
        "servers": [{"url": "https://api.example.com"}],
        "paths": paths if paths is not None else {
            "/v1/issues": {
                "get": {
                    "operationId": "listIssues",
                    "summary": "List issues in the workspace.",
                    "parameters": [
                        {"name": "limit", "in": "query", "schema": {"type": "integer"},
                         "description": "How many to return"},
                    ],
                },
                "post": {
                    "operationId": "createIssue",
                    "summary": "Create an issue.",
                    "requestBody": {
                        "content": {"application/json": {"schema": {
                            "type": "object",
                            "properties": {"title": {"type": "string"}},
                            "required": ["title"],
                        }}}
                    },
                },
            },
            "/v1/issues/{issueId}": {
                "get": {
                    "operationId": "getIssue",
                    "summary": "Fetch one issue by id.",
                    "parameters": [
                        {"name": "issueId", "in": "path", "required": True,
                         "schema": {"type": "string"}},
                    ],
                },
            },
        },
    }
    spec.update(overrides)
    return spec


def _by_name(operations):
    return {op["name"]: op for op in operations}


class DocumentValidationTests(unittest.TestCase):
    def test_a_non_object_is_rejected(self):
        with self.assertRaises(SpecError):
            operations_from_spec(["not", "a", "spec"])

    def test_a_document_without_a_version_is_rejected(self):
        with self.assertRaises(SpecError):
            operations_from_spec({"paths": {}})

    def test_a_spec_with_no_paths_is_rejected(self):
        with self.assertRaises(SpecError):
            operations_from_spec(_spec(paths={}))

    def test_a_spec_with_no_server_is_rejected_with_advice(self):
        spec = _spec()
        del spec["servers"]
        with self.assertRaises(SpecError) as ctx:
            operations_from_spec(spec)
        self.assertIn("server", str(ctx.exception).lower())

    def test_swagger_2_host_and_basepath_are_understood(self):
        spec = {
            "swagger": "2.0",
            "info": {"title": "Old API"},
            "host": "api.example.com",
            "basePath": "/v2",
            "paths": {"/things": {"get": {"operationId": "listThings",
                                          "summary": "List all of the things."}}},
        }
        info, operations, _ = operations_from_spec(spec)
        self.assertEqual(info["server_url"], "https://api.example.com/v2")
        self.assertTrue(operations[0]["request"]["url"].startswith("https://api.example.com/v2"))


class NamingTests(unittest.TestCase):
    def test_operation_id_becomes_a_legal_snake_case_name(self):
        self.assertEqual(tool_name_for("listIssues", "get", "/v1/issues"), "listissues")

    def test_a_missing_operation_id_falls_back_to_method_and_path(self):
        name = tool_name_for("", "get", "/v1/issues/{id}")
        self.assertTrue(name.startswith("get_v1_issues"))

    def test_punctuation_is_replaced(self):
        self.assertNotIn("-", tool_name_for("list-issues.v2", "get", "/x"))

    def test_names_are_deduplicated_within_one_spec(self):
        spec = _spec(paths={
            "/a": {"get": {"operationId": "same", "summary": "The first one here."}},
            "/b": {"get": {"operationId": "same", "summary": "The second one here."}},
        })
        _, operations, _ = operations_from_spec(spec)
        self.assertEqual(len({op["name"] for op in operations}), 2)

    def test_every_generated_name_is_legal_for_the_validator(self):
        import re

        _, operations, _ = operations_from_spec(_spec())
        for op in operations:
            self.assertRegex(op["name"], re.compile(r"^[a-z][a-z0-9_]{2,63}$"))


class ParameterTests(unittest.TestCase):
    def setUp(self):
        _, self.operations, self.skipped = operations_from_spec(_spec())
        self.ops = _by_name(self.operations)

    def test_a_query_parameter_becomes_an_argument_and_a_query_template(self):
        op = self.ops["listissues"]
        self.assertIn("limit", op["parameters"]["properties"])
        self.assertEqual(op["request"]["query"], {"limit": "{{args.limit}}"})

    def test_a_path_parameter_is_substituted_into_the_url(self):
        op = self.ops["getissue"]
        self.assertTrue(op["request"]["url"].endswith("/v1/issues/{{args.issueid}}"))

    def test_a_path_parameter_is_always_required(self):
        self.assertIn("issueid", self.ops["getissue"]["parameters"]["required"])

    def test_a_json_body_becomes_arguments_and_a_body_template(self):
        op = self.ops["createissue"]
        self.assertIn("title", op["parameters"]["properties"])
        self.assertEqual(op["request"]["body"], {"title": "{{args.title}}"})
        self.assertIn("title", op["parameters"]["required"])

    def test_descriptions_carry_through(self):
        prop = self.ops["listissues"]["parameters"]["properties"]["limit"]
        self.assertIn("How many", prop["description"])

    def test_an_enum_is_preserved(self):
        spec = _spec(paths={"/x": {"get": {
            "operationId": "getX", "summary": "Get an x of some kind.",
            "parameters": [{"name": "mode", "in": "query",
                            "schema": {"type": "string", "enum": ["a", "b"]}}],
        }}})
        _, operations, _ = operations_from_spec(spec)
        self.assertEqual(operations[0]["parameters"]["properties"]["mode"]["enum"], ["a", "b"])

    def test_path_level_parameters_apply_to_each_operation(self):
        spec = _spec(paths={"/x/{id}": {
            "parameters": [{"name": "id", "in": "path", "required": True,
                            "schema": {"type": "string"}}],
            "get": {"operationId": "getX", "summary": "Get one x by its id."},
        }})
        _, operations, _ = operations_from_spec(spec)
        self.assertIn("id", operations[0]["parameters"]["properties"])


class RefTests(unittest.TestCase):
    def test_a_local_ref_is_resolved(self):
        spec = _spec(paths={"/x": {"post": {
            "operationId": "makeX", "summary": "Make a brand new x.",
            "requestBody": {"$ref": "#/components/requestBodies/XBody"},
        }}})
        spec["components"] = {
            "requestBodies": {"XBody": {"content": {"application/json": {
                "schema": {"type": "object", "properties": {"nm": {"type": "string"}}}
            }}}}
        }
        _, operations, _ = operations_from_spec(spec)
        self.assertIn("nm", operations[0]["parameters"]["properties"])

    def test_a_remote_ref_is_refused(self):
        # Following one would be a fetch to an address the user chose.
        spec = _spec(paths={"/x": {"get": {
            "operationId": "getX", "summary": "Get an x from elsewhere.",
            "parameters": [{"$ref": "https://evil.example.com/params.json#/p"}],
        }}})
        _, operations, skipped = operations_from_spec(spec)
        self.assertEqual(operations, [])
        self.assertTrue(any("$ref" in s["reason"] for s in skipped))


class SkippingTests(unittest.TestCase):
    """What cannot be represented honestly is skipped, with a reason."""

    def test_a_deprecated_operation_is_skipped(self):
        spec = _spec(paths={"/x": {"get": {
            "operationId": "oldX", "summary": "The old way of getting x.",
            "deprecated": True,
        }}})
        _, operations, skipped = operations_from_spec(spec)
        self.assertEqual(operations, [])
        self.assertIn("deprecated", skipped[0]["reason"])

    def test_an_operation_needing_an_undeclared_path_parameter_is_skipped(self):
        # Otherwise the URL would keep a literal {id} and fail at call time.
        spec = _spec(paths={"/x/{id}": {"get": {
            "operationId": "getX", "summary": "Get one x by id.",
        }}})
        _, operations, skipped = operations_from_spec(spec)
        self.assertEqual(operations, [])
        self.assertIn("id", skipped[0]["reason"])

    def test_a_required_body_field_of_unsupported_type_skips_the_operation(self):
        spec = _spec(paths={"/x": {"post": {
            "operationId": "makeX", "summary": "Make an x with nested data.",
            "requestBody": {"content": {"application/json": {"schema": {
                "type": "object",
                "properties": {"nested": {"type": "object"}},
                "required": ["nested"],
            }}}},
        }}})
        _, operations, skipped = operations_from_spec(spec)
        self.assertEqual(operations, [])
        self.assertIn("nested", skipped[0]["reason"])

    def test_an_optional_field_of_unsupported_type_only_warns(self):
        spec = _spec(paths={"/x": {"post": {
            "operationId": "makeX", "summary": "Make an x with an optional blob.",
            "requestBody": {"content": {"application/json": {"schema": {
                "type": "object",
                "properties": {"nm": {"type": "string"}, "nested": {"type": "object"}},
                "required": ["nm"],
            }}}},
        }}})
        _, operations, _ = operations_from_spec(spec)
        self.assertEqual(len(operations), 1)
        self.assertTrue(any("nested" in w for w in operations[0]["warnings"]))

    def test_an_operation_with_too_many_arguments_is_skipped(self):
        params = [
            {"name": f"p{i}", "in": "query", "schema": {"type": "string"}}
            for i in range(30)
        ]
        spec = _spec(paths={"/x": {"get": {
            "operationId": "getX", "summary": "Get x with many knobs.",
            "parameters": params,
        }}})
        _, operations, skipped = operations_from_spec(spec)
        self.assertEqual(operations, [])
        self.assertIn("arguments", skipped[0]["reason"])

    def test_the_operation_count_is_capped_and_the_rest_reported(self):
        paths = {
            f"/p{i}": {"get": {"operationId": f"getP{i}", "summary": f"Get p{i} now."}}
            for i in range(MAX_OPERATIONS + 5)
        }
        _, operations, skipped = operations_from_spec(_spec(paths=paths))
        self.assertEqual(len(operations), MAX_OPERATIONS)
        self.assertEqual(len(skipped), 5)
        self.assertIn(str(MAX_OPERATIONS), skipped[0]["reason"])

    def test_a_non_json_body_warns_rather_than_failing(self):
        spec = _spec(paths={"/x": {"post": {
            "operationId": "upload", "summary": "Upload a file of some kind.",
            "requestBody": {"content": {"multipart/form-data": {"schema": {"type": "object"}}}},
        }}})
        _, operations, _ = operations_from_spec(spec)
        self.assertEqual(len(operations), 1)
        self.assertTrue(any("not JSON" in w for w in operations[0]["warnings"]))


class DescriptionTests(unittest.TestCase):
    def test_summary_and_description_are_combined(self):
        spec = _spec(paths={"/x": {"get": {
            "operationId": "getX", "summary": "Get an x.",
            "description": "Returns the current x for the workspace.",
        }}})
        _, operations, _ = operations_from_spec(spec)
        text = operations[0]["description"]
        self.assertIn("Get an x", text)
        self.assertIn("workspace", text)

    def test_a_missing_summary_still_yields_a_usable_description(self):
        spec = _spec(paths={"/x": {"get": {"operationId": "getX"}}})
        _, operations, _ = operations_from_spec(spec)
        self.assertGreaterEqual(len(operations[0]["description"]), 10)

    def test_a_very_short_summary_is_padded_to_the_minimum(self):
        # The validator rejects anything under 10 characters.
        spec = _spec(paths={"/x": {"get": {"operationId": "getX", "summary": "Go"}}})
        _, operations, _ = operations_from_spec(spec)
        self.assertGreaterEqual(len(operations[0]["description"]), 10)


class RecordsAreRealToolsTests(unittest.TestCase):
    """The decisive test: an imported record must build as a tool and obey the
    same rules a hand-written one does."""

    def test_every_imported_record_builds_as_an_http_tool(self):
        _, operations, _ = operations_from_spec(_spec())
        for op in operations:
            record = dict(op)
            record["credentialRef"] = "EXAMPLE"
            tool = HttpTool(record)  # raises if the record is not usable
            self.assertEqual(tool.origin, "https://api.example.com")

    def test_the_destination_is_literal_in_every_record(self):
        _, operations, _ = operations_from_spec(_spec())
        for op in operations:
            self.assertNotIn("{{", op["request"]["url"].split("://", 1)[1].split("/", 1)[0])

    def test_every_args_placeholder_names_a_declared_parameter(self):
        # HttpTool enforces this itself, so a mismatch would raise above; this
        # asserts it directly so a failure names the real cause.
        _, operations, _ = operations_from_spec(_spec())
        for op in operations:
            declared = set(op["parameters"]["properties"])
            blob = repr(op["request"])
            for key in declared:
                pass
            import re
            for referenced in re.findall(r"\{\{args\.([a-z0-9_]+)}}", blob):
                self.assertIn(referenced, declared, f"{op['name']} references {referenced}")

    def test_records_are_marked_as_http_tools(self):
        _, operations, _ = operations_from_spec(_spec())
        self.assertTrue(all(op["provider"] == "http" for op in operations))


if __name__ == "__main__":
    unittest.main()
