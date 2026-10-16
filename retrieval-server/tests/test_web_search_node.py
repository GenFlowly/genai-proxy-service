"""Unit tests for the WEB_SEARCH graph node's API-key resolution.

The Tavily HTTP call and the DynamoDB/KMS credential lookup are both patched;
these exercise precedence only: the customer's stored WEB_SEARCH credential
(the key saved from the Settings page) wins over the node config's api_key,
which wins over the TAVILY_API_KEY env var — and a lookup failure degrades to
the fallbacks instead of aborting the turn.

Run with:
    .venv/bin/python -m unittest tests.test_web_search_node
"""
import unittest
from unittest.mock import AsyncMock, patch

from graph.nodes.web_search import web_search


def _state(config: dict | None = None) -> dict:
    return {
        "customer_id": "cust-1",
        "original_query": "what changed today",
        "node_configs": {"WEB_SEARCH": config or {}},
    }


def _lookup(values: dict | None):
    """Stand-in for resolve_tool_credentials: {ref: values} like the real one."""
    def resolve(customer_id, refs):
        return {ref: (values or {}) for ref in refs}
    return resolve


class WebSearchNodeKeyResolutionTest(unittest.IsolatedAsyncioTestCase):
    async def _run(self, config, stored, env, lookup=None):
        """Execute the node with everything external patched; returns the key
        _tavily_search received (or None when it was never called) + the update."""
        search = AsyncMock(return_value={"results": [], "answer": ""})
        with patch.dict("os.environ", env, clear=True), \
                patch("graph.nodes.web_search._tavily_search", search), \
                patch(
                    "graph.nodes.web_search.resolve_tool_credentials",
                    lookup or _lookup(stored),
                ):
            update = await web_search()(_state(config))
        key = search.await_args.args[1] if search.await_args else None
        return key, update

    async def test_customer_stored_key_wins_over_config_and_env(self):
        key, _ = await self._run(
            config={"api_key": "config-key"},
            stored={"api_key": "customer-key"},
            env={"TAVILY_API_KEY": "env-key"},
        )
        self.assertEqual(key, "customer-key")

    async def test_falls_back_to_node_config_when_no_stored_key(self):
        key, _ = await self._run(
            config={"api_key": "config-key"},
            stored={},
            env={"TAVILY_API_KEY": "env-key"},
        )
        self.assertEqual(key, "config-key")

    async def test_falls_back_to_env_when_no_stored_or_config_key(self):
        key, _ = await self._run(
            config={}, stored={}, env={"TAVILY_API_KEY": "env-key"},
        )
        self.assertEqual(key, "env-key")

    async def test_lookup_failure_degrades_to_env_key(self):
        def boom(customer_id, refs):
            raise RuntimeError("ddb down")

        key, update = await self._run(
            config={}, stored=None, env={"TAVILY_API_KEY": "env-key"}, lookup=boom,
        )
        self.assertEqual(key, "env-key")
        self.assertNotIn("error", update)

    async def test_no_key_anywhere_surfaces_config_error(self):
        key, update = await self._run(config={}, stored={}, env={})
        self.assertIsNone(key)
        self.assertEqual(update["web_search_results"], [])
        self.assertIn("error", update)
