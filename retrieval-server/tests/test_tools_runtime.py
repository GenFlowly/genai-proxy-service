"""
Unit tests for graph.tools_runtime — the seam that makes tool availability a
property of the REQUEST rather than of the process.

Run with `python -m unittest tests.test_tools_runtime`.

These are the tests that were missing when tool availability was a module
global: nothing covered tools_runtime, the registry, or how a tool receives
credentials. The behaviors pinned here are the ones a per-customer tool tier
will depend on.
"""
import unittest
from unittest.mock import patch

from graph_tools.base import GraphTool, ToolContext, ToolResult
from graph_tools.registry import ToolRegistry

import graph.tools_runtime as tools_runtime
from graph.tools_runtime import (
    all_builtin_tool_names,
    credential_refs_for,
    make_tool_context,
    specs_for,
    tools_for,
)


class _Stub(GraphTool):
    def __init__(self, name, credential_ref=None):
        self.name = name
        self.description = f"stub {name}"
        self.parameters = {"type": "object", "properties": {}}
        self.credential_ref = credential_ref

    async def run(self, args: dict, context: ToolContext) -> ToolResult:
        return ToolResult(content="ok")


def _registry(*tools) -> ToolRegistry:
    registry = ToolRegistry()
    for tool in tools:
        registry.register(tool)
    return registry


class ToolsForTests(unittest.TestCase):
    def test_resolves_enabled_names_in_order(self):
        with patch.object(tools_runtime, "get_registry",
                          return_value=_registry(_Stub("a"), _Stub("b"))):
            self.assertEqual([t.name for t in tools_for(["b", "a"])], ["b", "a"])

    def test_drops_unknown_names_instead_of_raising(self):
        # A stale TOOL_EXECUTOR node config must never break a request.
        with patch.object(tools_runtime, "get_registry", return_value=_registry(_Stub("a"))):
            self.assertEqual([t.name for t in tools_for(["a", "gone"])], ["a"])

    def test_deduplicates(self):
        with patch.object(tools_runtime, "get_registry", return_value=_registry(_Stub("a"))):
            self.assertEqual([t.name for t in tools_for(["a", "a"])], ["a"])

    def test_empty_and_none_are_safe(self):
        with patch.object(tools_runtime, "get_registry", return_value=_registry(_Stub("a"))):
            self.assertEqual(tools_for([]), [])
            self.assertEqual(tools_for(None), [])
            self.assertEqual(tools_for(["", None]), [])

    def test_enabling_nothing_enables_nothing(self):
        # The security-relevant direction: an empty enabled list must not fall
        # back to "everything registered".
        with patch.object(tools_runtime, "get_registry",
                          return_value=_registry(_Stub("a"), _Stub("b"))):
            self.assertEqual(tools_for([]), [])


class SpecsForTests(unittest.TestCase):
    def test_specs_are_the_model_facing_shape(self):
        with patch.object(tools_runtime, "get_registry", return_value=_registry(_Stub("a"))):
            specs = specs_for(["a"])

        self.assertEqual(len(specs), 1)
        self.assertEqual(set(specs[0]), {"name", "description", "parameters"})
        self.assertEqual(specs[0]["name"], "a")

    def test_credential_ref_is_never_exposed_to_the_model(self):
        with patch.object(tools_runtime, "get_registry",
                          return_value=_registry(_Stub("a", credential_ref="WEB_SEARCH"))):
            specs = specs_for(["a"])

        self.assertNotIn("credential_ref", specs[0])


class CredentialRefsTests(unittest.TestCase):
    def test_collects_distinct_refs_and_skips_tools_without_one(self):
        refs = credential_refs_for([
            _Stub("a", credential_ref="WEB_SEARCH"),
            _Stub("b", credential_ref="WEB_SEARCH"),
            _Stub("c"),
        ])
        self.assertEqual(refs, {"WEB_SEARCH"})

    def test_empty_when_no_tool_needs_credentials(self):
        self.assertEqual(credential_refs_for([_Stub("a"), _Stub("b")]), set())


class MakeToolContextTests(unittest.TestCase):
    def test_default_context_exposes_no_secrets(self):
        context = make_tool_context("cust-1")
        self.assertEqual(context.secrets("WEB_SEARCH"), {})

    def test_injected_secrets_reach_the_tool(self):
        context = make_tool_context("cust-1", secrets={"WEB_SEARCH": {"api_key": "k"}}.get)
        self.assertEqual(context.secrets("WEB_SEARCH"), {"api_key": "k"})

    def test_key_template_matches_the_proxy_convention(self):
        context = make_tool_context("cust-1")
        self.assertEqual(
            context.key_template, "customers/{customer_id}/attachments/{artifact_id}"
        )

    def test_attachment_store_is_lazy(self):
        # Building the context must not require ATTACHMENTS_BUCKET: tools that
        # never store anything (web_search) would otherwise fail outside the
        # executor's per-call error handling.
        with patch.dict("os.environ", {}, clear=True):
            context = make_tool_context("cust-1")  # must not raise
            with self.assertRaises(RuntimeError):
                context.store.put("k", b"data", "text/plain")


class BuiltinNamesTests(unittest.TestCase):
    def test_lists_the_shipped_builtins(self):
        names = all_builtin_tool_names()
        self.assertIn("web_search", names)
        self.assertIn("generate_pdf", names)

    def test_search_knowledge_base_is_registered_but_never_implicit(self):
        # Registered: a TOOL_EXECUTOR config naming it resolves it as a
        # built-in. Excluded from the implicit all-built-ins default: an
        # existing pipeline graph with an unscoped TOOL_EXECUTOR node must not
        # start retrieving twice just because this tool shipped.
        self.assertTrue(tools_runtime.get_registry().has("search_knowledge_base"))
        self.assertEqual(
            [t.name for t in tools_for(["search_knowledge_base"])],
            ["search_knowledge_base"],
        )
        self.assertNotIn("search_knowledge_base", all_builtin_tool_names())


if __name__ == "__main__":
    unittest.main()
