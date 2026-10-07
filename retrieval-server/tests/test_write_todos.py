"""
Unit tests for graph_tools.tools.write_todos — the agent's planning tool.

Run with `python -m unittest tests.test_write_todos`.
"""
import unittest

from graph_tools.base import ToolContext
from graph_tools.tools.write_todos import WriteTodosTool


def _context() -> ToolContext:
    return ToolContext(customer_id="cust-1", store=None)


class WriteTodosTests(unittest.IsolatedAsyncioTestCase):
    async def test_full_list_lands_in_the_state_patch_and_renders_as_checkboxes(self):
        out = await WriteTodosTool().run(
            {"todos": [
                {"content": "Search the KB", "status": "completed"},
                {"content": "Summarize findings", "status": "in_progress"},
                {"content": "Draft the answer", "status": "pending"},
            ]},
            _context(),
        )

        self.assertEqual(out.state_patch["todos"], [
            {"content": "Search the KB", "status": "completed"},
            {"content": "Summarize findings", "status": "in_progress"},
            {"content": "Draft the answer", "status": "pending"},
        ])
        self.assertIn("1/3 completed", out.content)
        self.assertIn("[x] Search the KB", out.content)
        self.assertIn("[~] Summarize findings", out.content)
        self.assertIn("[ ] Draft the answer", out.content)

    async def test_junk_entries_are_dropped_not_fatal(self):
        out = await WriteTodosTool().run(
            {"todos": [
                {"content": "  ", "status": "pending"},     # blank → dropped
                {"content": "Real task", "status": "bogus"},  # bad status → pending
                42,                                          # junk → dropped
                "bare string task",                          # string → pending item
            ]},
            _context(),
        )

        self.assertEqual(out.state_patch["todos"], [
            {"content": "Real task", "status": "pending"},
            {"content": "bare string task", "status": "pending"},
        ])

    async def test_non_list_is_an_error_without_a_state_patch(self):
        out = await WriteTodosTool().run({"todos": "do things"}, _context())
        self.assertIn("Error", out.content)
        self.assertEqual(out.state_patch, {})

    async def test_empty_list_clears_the_plan(self):
        out = await WriteTodosTool().run({"todos": []}, _context())
        self.assertEqual(out.state_patch, {"todos": []})
        self.assertIn("cleared", out.content)


if __name__ == "__main__":
    unittest.main()
