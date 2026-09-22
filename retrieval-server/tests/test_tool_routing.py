"""
Unit tests for the "tool_route" conditional edge in graph.dynamic_graph.

Run with `python -m unittest tests.test_tool_routing`.

The router decides whether a model's tool calls are executed IN-GRAPH by the
TOOL_EXECUTOR node or handed back to the API caller. It used to answer that
from a process-global registry, which meant the decision could not depend on
the customer. It now reads state["builtin_tools"] — the set enabled for this
request — so a per-customer tool routes correctly. These tests pin that.
"""
import unittest

from graph.dynamic_graph import _make_condition_router

ROUTES = {"builtin": "exec_node", "caller": "__end__", "none": "done_node"}


def _router(routes=None, condition=None):
    return _make_condition_router(
        condition or {"condition_type": "tool_route"}, routes or ROUTES
    )


def _state(calls=None, enabled=None):
    return {"tool_calls": calls, "builtin_tools": enabled or []}


class ToolRouteTests(unittest.TestCase):
    def test_enabled_tool_routes_in_graph(self):
        route = _router()(_state([{"name": "web_search"}], ["web_search"]))
        self.assertEqual(route, "exec_node")

    def test_tool_not_enabled_for_this_request_routes_to_the_caller(self):
        # The same name, same process, different customer: not enabled here, so
        # it is the caller's tool to execute.
        route = _router()(_state([{"name": "web_search"}], []))
        self.assertEqual(route, "__end__")

    def test_mixed_turn_routes_in_graph(self):
        route = _router()(
            _state([{"name": "caller_tool"}, {"name": "web_search"}], ["web_search"])
        )
        self.assertEqual(route, "exec_node")

    def test_no_calls_routes_to_none(self):
        self.assertEqual(_router()(_state(None, ["web_search"])), "done_node")
        self.assertEqual(_router()(_state([], ["web_search"])), "done_node")

    def test_a_name_enabled_but_unregistered_still_routes_in_graph(self):
        # Routing is authorization, not resolution. The executor drops a name it
        # cannot resolve and says so; routing must not silently send an enabled
        # call to the caller.
        route = _router()(_state([{"name": "customer_tool"}], ["customer_tool"]))
        self.assertEqual(route, "exec_node")

    def test_call_without_a_name_is_not_treated_as_in_graph(self):
        route = _router()(_state([{}], ["web_search"]))
        self.assertEqual(route, "__end__")

    def test_falls_back_to_default_route_when_label_missing(self):
        routes = {"__default__": "fallback_node"}
        self.assertEqual(_router(routes)(_state([{"name": "x"}], ["x"])), "fallback_node")

    def test_tool_route_does_not_require_a_condition_key(self):
        # A tool_route edge ignores condition_key; demanding one made an
        # otherwise valid edge raise while the graph was being built.
        router = _make_condition_router({"condition_type": "tool_route"}, ROUTES)
        self.assertEqual(router(_state([{"name": "web_search"}], ["web_search"])), "exec_node")


class OtherConditionTypesStillWorkTests(unittest.TestCase):
    """The tool_route change must not disturb the other condition types, which
    do read condition_key."""

    def test_bool_condition(self):
        router = _make_condition_router(
            {"condition_key": "flag", "condition_type": "bool"},
            {"true": "yes_node", "false": "no_node"},
        )
        self.assertEqual(router({"flag": True, "scratch": {}}), "yes_node")
        self.assertEqual(router({"flag": False, "scratch": {}}), "no_node")

    def test_list_empty_condition(self):
        router = _make_condition_router(
            {"condition_key": "items", "condition_type": "list_empty"},
            {"true": "empty_node", "false": "full_node"},
        )
        self.assertEqual(router({"items": [], "scratch": {}}), "empty_node")
        self.assertEqual(router({"items": [1], "scratch": {}}), "full_node")

    def test_value_condition_reads_scratch(self):
        router = _make_condition_router(
            {"condition_key": "intent", "condition_type": "value"},
            {"buy": "buy_node", "__default__": "other_node"},
        )
        self.assertEqual(router({"scratch": {"intent": "buy"}}), "buy_node")
        self.assertEqual(router({"scratch": {"intent": "sell"}}), "other_node")


if __name__ == "__main__":
    unittest.main()
