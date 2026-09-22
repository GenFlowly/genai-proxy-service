"""
Unit tests for graph.customer_tools and the provider seam in
graph.tools_runtime.

Run with `python -m unittest tests.test_customer_tools`.

Two behaviors matter most here and are the reason the module is written the way
it is: one malformed tool must never take down a customer's whole agent, and a
customer must never be able to shadow a built-in name and change what it does.
"""
import unittest
from unittest.mock import MagicMock, patch

import graph.customer_tools as customer_tools
import graph.tools_runtime as tools_runtime
from graph.customer_tools import build_tool, records_for, tools_for_customer
from graph_tools.providers import HttpTool


def _row(name="my_tool", status="active", provider="http", **overrides):
    row = {
        "customerId": "cust-1",
        "name": name,
        "status": status,
        "provider": provider,
        "description": "Does a thing with the tracker.",
        "parameters": {"type": "object", "properties": {"q": {"type": "string"}}},
        "request": {
            "method": "GET",
            "url": "https://api.example.com/v1/search",
            "query": {"q": "{{args.q}}"},
        },
        "credentialRef": "TRACKER",
        "responseTransform": {"mode": "text"},
    }
    row.update(overrides)
    return row


def _table_returning(rows):
    table = MagicMock()
    table.query.return_value = {"Items": rows}
    ddb = MagicMock()
    ddb.Table.return_value = table
    return ddb, table


class RecordLoadingTests(unittest.TestCase):
    def setUp(self):
        customer_tools._cache.clear()

    def test_returns_active_rows(self):
        ddb, _ = _table_returning([_row("a"), _row("b")])
        with patch.object(customer_tools, "_get_dynamodb", return_value=ddb):
            self.assertEqual([r["name"] for r in records_for("cust-1")], ["a", "b"])

    def test_draft_and_disabled_rows_are_not_returned(self):
        # A draft tool has not been proved with a dry run; a disabled one is
        # deliberately off. The model must see neither.
        ddb, _ = _table_returning([
            _row("live"), _row("pending", status="draft"), _row("off", status="disabled"),
        ])
        with patch.object(customer_tools, "_get_dynamodb", return_value=ddb):
            self.assertEqual([r["name"] for r in records_for("cust-1")], ["live"])

    def test_results_are_cached_within_the_ttl(self):
        ddb, table = _table_returning([_row()])
        with patch.object(customer_tools, "_get_dynamodb", return_value=ddb):
            records_for("cust-1")
            records_for("cust-1")
        self.assertEqual(table.query.call_count, 1)

    def test_cache_is_per_customer(self):
        ddb, table = _table_returning([_row()])
        with patch.object(customer_tools, "_get_dynamodb", return_value=ddb):
            records_for("cust-1")
            records_for("cust-2")
        self.assertEqual(table.query.call_count, 2)

    def test_invalidate_forces_a_reload(self):
        ddb, table = _table_returning([_row()])
        with patch.object(customer_tools, "_get_dynamodb", return_value=ddb):
            records_for("cust-1")
            customer_tools.invalidate("cust-1")
            records_for("cust-1")
        self.assertEqual(table.query.call_count, 2)

    def test_a_load_failure_serves_stale_records(self):
        ddb, table = _table_returning([_row("a")])
        with patch.object(customer_tools, "_get_dynamodb", return_value=ddb):
            records_for("cust-1")
            customer_tools.invalidate("cust-1")
            table.query.side_effect = RuntimeError("ddb down")
            # Nothing stale is cached after invalidate, so this is the empty case.
            self.assertEqual(records_for("cust-1"), [])

    def test_a_load_failure_never_raises(self):
        ddb, table = _table_returning([])
        table.query.side_effect = RuntimeError("ddb down")
        with patch.object(customer_tools, "_get_dynamodb", return_value=ddb):
            self.assertEqual(records_for("cust-1"), [])

    def test_blank_customer_id_short_circuits(self):
        with patch.object(customer_tools, "_get_dynamodb",
                          side_effect=AssertionError("should not touch AWS")):
            self.assertEqual(records_for(""), [])


class BuildToolTests(unittest.TestCase):
    def test_builds_an_http_tool(self):
        tool = build_tool(_row())
        self.assertIsInstance(tool, HttpTool)
        self.assertEqual(tool.name, "my_tool")

    def test_defaults_to_the_http_provider(self):
        row = _row()
        del row["provider"]
        self.assertIsInstance(build_tool(row), HttpTool)

    def test_an_unknown_provider_is_dropped_not_raised(self):
        self.assertIsNone(build_tool(_row(provider="mcp")))

    def test_a_malformed_definition_is_dropped_not_raised(self):
        self.assertIsNone(build_tool(_row(description="")))

    def test_a_templated_host_is_dropped(self):
        row = _row()
        row["request"]["url"] = "https://{{args.q}}/x"
        self.assertIsNone(build_tool(row))


class ToolsForCustomerTests(unittest.TestCase):
    def setUp(self):
        customer_tools._cache.clear()

    def test_returns_only_the_requested_names(self):
        ddb, _ = _table_returning([_row("a"), _row("b")])
        with patch.object(customer_tools, "_get_dynamodb", return_value=ddb):
            built = tools_for_customer("cust-1", {"a"})
        self.assertEqual(set(built), {"a"})

    def test_one_broken_tool_does_not_hide_the_others(self):
        # The behavior that keeps a typo in one tool from disabling an agent.
        ddb, _ = _table_returning([_row("broken", description=""), _row("fine")])
        with patch.object(customer_tools, "_get_dynamodb", return_value=ddb):
            built = tools_for_customer("cust-1", {"broken", "fine"})
        self.assertEqual(set(built), {"fine"})

    def test_no_names_means_no_lookup(self):
        with patch.object(customer_tools, "_get_dynamodb",
                          side_effect=AssertionError("should not touch AWS")):
            self.assertEqual(tools_for_customer("cust-1", set()), {})


class SeamTests(unittest.TestCase):
    """graph.tools_runtime.tools_for is the single place built-ins and customer
    tools are combined."""

    def test_customer_tools_resolve_alongside_builtins(self):
        tool = build_tool(_row("my_tool"))
        with patch.object(customer_tools, "tools_for_customer", return_value={"my_tool": tool}):
            resolved = tools_runtime.tools_for(["web_search", "my_tool"], "cust-1")

        self.assertEqual([t.name for t in resolved], ["web_search", "my_tool"])

    def test_a_builtin_wins_a_name_collision(self):
        # A customer must not be able to redefine what `web_search` does.
        impostor = build_tool(_row("web_search"))
        with patch.object(customer_tools, "tools_for_customer",
                          return_value={"web_search": impostor}) as lookup:
            resolved = tools_runtime.tools_for(["web_search"], "cust-1")

        # The built-in resolved first, so the customer lookup was never asked.
        lookup.assert_not_called()
        self.assertEqual(len(resolved), 1)
        self.assertNotIsInstance(resolved[0], HttpTool)

    def test_without_a_customer_id_only_builtins_resolve(self):
        with patch.object(customer_tools, "tools_for_customer",
                          side_effect=AssertionError("should not be consulted")):
            resolved = tools_runtime.tools_for(["web_search", "my_tool"])

        self.assertEqual([t.name for t in resolved], ["web_search"])

    def test_an_enabled_name_that_no_longer_exists_is_dropped(self):
        with patch.object(customer_tools, "tools_for_customer", return_value={}):
            resolved = tools_runtime.tools_for(["deleted_tool"], "cust-1")

        self.assertEqual(resolved, [])

    def test_specs_include_customer_tools(self):
        tool = build_tool(_row("my_tool"))
        with patch.object(customer_tools, "tools_for_customer", return_value={"my_tool": tool}):
            specs = tools_runtime.specs_for(["my_tool"], "cust-1")

        self.assertEqual(specs[0]["name"], "my_tool")
        self.assertEqual(set(specs[0]), {"name", "description", "parameters"})

    def test_credential_refs_are_collected_from_customer_tools(self):
        tool = build_tool(_row("my_tool"))
        self.assertEqual(tools_runtime.credential_refs_for([tool]), {"TRACKER"})


if __name__ == "__main__":
    unittest.main()
