"""
Unit tests for graph/fs_tools.py — the scratch filesystem.

Run with `python -m unittest tests.test_fs_tools`.

Pinned here: tenant/run isolation comes from the host-built prefix (never a
model argument), path traversal is rejected, reads page with offset/length,
and a missing namespace degrades to a message rather than an exception.
"""
import tempfile
import unittest

from graph_tools.base import ToolContext
from graph_tools.storage import LocalDiskArtifactStore
from graph.fs_tools import FsListTool, FsReadTool, FsWriteTool, safe_path

_PREFIX = "customers/cust-1/agent-fs/ns-1/"


def _context(tmpdir: str) -> ToolContext:
    context = ToolContext(customer_id="cust-1", store=LocalDiskArtifactStore(tmpdir))
    context.runtime["fs_prefix"] = _PREFIX
    return context


class SafePathTests(unittest.TestCase):
    def test_accepts_plain_relative_paths(self):
        self.assertEqual(safe_path("notes/findings.md"), "notes/findings.md")
        self.assertEqual(safe_path("a.txt"), "a.txt")

    def test_rejects_traversal_and_hidden_segments(self):
        for bad in ("../x", "a/../../x", "a/.hidden", ".env", "a\\b", "", None, 42):
            self.assertIsNone(safe_path(bad), bad)

    def test_normalizes_a_leading_slash_instead_of_escaping(self):
        # "/abs" cannot escape the prefix — it just becomes relative.
        self.assertEqual(safe_path("/notes/a.md"), "notes/a.md")


class FsToolsTests(unittest.IsolatedAsyncioTestCase):
    async def test_writes_carry_the_scratch_tag_the_lifecycle_rule_expires(self):
        writes = []

        class _Store:
            def put(self, key, data, content_type, tags=None):
                writes.append((key, tags))

        with tempfile.TemporaryDirectory() as tmp:
            context = _context(tmp)
            context.store = _Store()
            await FsWriteTool().run({"path": "notes/a.md", "content": "x"}, context)

        self.assertEqual(1, len(writes))
        self.assertEqual({"retention": "scratch"}, writes[0][1])

    async def test_write_then_read_roundtrip_under_the_run_prefix(self):
        with tempfile.TemporaryDirectory() as tmp:
            context = _context(tmp)
            wrote = await FsWriteTool().run(
                {"path": "notes/a.md", "content": "hello scratch"}, context
            )
            self.assertIn("Wrote", wrote.content)
            self.assertEqual(wrote.state_patch, {"fs_files": {"notes/a.md": 13}})

            read = await FsReadTool().run({"path": "notes/a.md"}, context)
            self.assertIn("hello scratch", read.content)
            self.assertIn("13 chars total", read.content)

    async def test_read_pages_with_offset_and_length(self):
        with tempfile.TemporaryDirectory() as tmp:
            context = _context(tmp)
            await FsWriteTool().run({"path": "big.txt", "content": "0123456789"}, context)

            page = await FsReadTool().run(
                {"path": "big.txt", "offset": 2, "length": 4}, context
            )
            self.assertIn("2345", page.content)
            self.assertNotIn("6789", page.content)
            self.assertIn("continue with offset=6", page.content)

    async def test_missing_file_and_bad_path_are_messages_not_exceptions(self):
        with tempfile.TemporaryDirectory() as tmp:
            context = _context(tmp)
            missing = await FsReadTool().run({"path": "nope.txt"}, context)
            self.assertIn("does not exist", missing.content)
            bad = await FsWriteTool().run({"path": "../sneaky", "content": "x"}, context)
            self.assertIn("invalid path", bad.content)

    async def test_list_shows_only_this_runs_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            context = _context(tmp)
            # Another run's file under the same customer must stay invisible.
            context.store.put(
                "customers/cust-1/agent-fs/OTHER/leak.txt", b"x", "text/plain"
            )
            await FsWriteTool().run({"path": "mine.txt", "content": "abc"}, context)

            listing = await FsListTool().run({}, context)
            self.assertIn("mine.txt (3 bytes)", listing.content)
            self.assertNotIn("leak", listing.content)

    async def test_no_namespace_degrades_to_a_message(self):
        with tempfile.TemporaryDirectory() as tmp:
            context = ToolContext(customer_id="cust-1", store=LocalDiskArtifactStore(tmp))
            out = await FsWriteTool().run({"path": "a", "content": "x"}, context)
            self.assertIn("not available", out.content)


if __name__ == "__main__":
    unittest.main()
