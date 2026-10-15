"""
Unit tests for revising generated PDFs and writing long ones in sections:
revise_pdf / read_pdf_source (plan 3.3), conversation file references
(3.1), companion enablement (3.2), fs_write append and
generate_pdf(source_paths=...) (3.6).

Run with `python -m unittest tests.test_pdf_revise`.
"""
import asyncio
import io
import unittest

from graph import conversation_files
from graph.fs_tools import FsWriteTool
from graph.tools_runtime import request_runtime, with_companions
from graph_tools.base import ToolContext
from graph_tools.tools import generate_pdf as gp
from graph_tools.tools.revise_pdf import ReadPdfSourceTool, RevisePdfTool, _next_filename, apply_edits

_TEMPLATE = "customers/{customer_id}/attachments/{artifact_id}"


class _MemoryStore:
    def __init__(self):
        self.objects: dict = {}

    def put(self, key, data, content_type, *, tags=None, filename=None):
        self.objects[key] = data

    def get(self, key):
        if key not in self.objects:
            raise KeyError(key)
        return self.objects[key]

    def list(self, prefix):
        return [{"key": k, "size": len(v)} for k, v in self.objects.items() if k.startswith(prefix)]


def _run(coro):
    return asyncio.run(coro)


def _pdf_text(pdf: bytes) -> str:
    from pypdf import PdfReader

    return "\n".join(p.extract_text() or "" for p in PdfReader(io.BytesIO(pdf)).pages)


class _Conversation:
    """A conversation whose first turn generated a PDF (in another
    participant's prefix, as in a shared conversation)."""

    def __init__(self, source: str | None = "# Offer\n\nStart date: 1 March 2026.\n\nSalary: [Amount]."):
        self.store = _MemoryStore()
        self.key = "customers/owner-1/attachments/a1b2c3d4-0000-0000-0000-000000000001"
        self.store.objects[self.key] = b"%PDF-1.4 original"
        if source is not None:
            self.store.objects[f"{self.key}.source.md"] = source.encode("utf-8")
        self.files = conversation_files.collect([
            {"role": "user", "content": "make an offer letter", "files": [
                {"attachment_id": "up-1", "s3_key": "customers/recipient-2/attachments/up-1",
                 "media_type": "application/pdf", "filename": "cv.pdf", "origin": "uploaded"},
            ]},
            {"role": "assistant", "content": "Done.", "files": [
                {"attachment_id": "a1b2c3d4-0000-0000-0000-000000000001", "s3_key": self.key,
                 "media_type": "application/pdf", "filename": "offer.pdf", "size_bytes": 17,
                 "origin": "generated"},
            ]},
        ])

    def context(self, **runtime) -> ToolContext:
        context = ToolContext(customer_id="recipient-2", store=self.store, key_template=_TEMPLATE,
                              artifact_tags={"retention": "pending"})
        context.runtime.update({"conversation_files": conversation_files.by_id(self.files), **runtime})
        return context


class ConversationFilesTests(unittest.TestCase):
    def test_collect_keeps_stored_keys_and_dedupes(self):
        conv = _Conversation()
        ids = [f["attachment_id"] for f in conv.files]
        self.assertEqual(ids, ["up-1", "a1b2c3d4-0000-0000-0000-000000000001"])
        by_id = conversation_files.by_id(conv.files)
        # Another participant's prefix, exactly as stored.
        self.assertEqual(by_id["up-1"]["s3_key"], "customers/recipient-2/attachments/up-1")
        self.assertEqual(by_id["a1b2c3d4-0000-0000-0000-000000000001"]["origin"], "generated")
        twice = conversation_files.collect([{"files": conv.files}], conv.files)
        self.assertEqual(len(twice), 2)

    def test_refs_without_a_key_are_dropped(self):
        self.assertEqual(conversation_files.collect([{"files": [{"attachment_id": "x"}]}]), [])

    def test_history_turns_name_their_files(self):
        from graph.nodes.llm_node import _file_context, _with_file_context

        turn = {"role": "assistant", "content": "Here it is.", "files": [
            {"attachment_id": "a1", "s3_key": "k", "media_type": "application/pdf",
             "filename": "offer.pdf", "origin": "generated"}]}
        self.assertEqual(_file_context(turn), "[Generated file: offer.pdf, id=a1]")
        self.assertEqual(_with_file_context("Here it is.", turn),
                         "Here it is.\n\n[Generated file: offer.pdf, id=a1]")
        self.assertEqual(_with_file_context("x", {"content": "x"}), "x")


class NamespaceSeedTests(unittest.TestCase):
    def _state(self, ns):
        from models import RetrieveRequest
        from routes.retrieve import _build_state

        req = RetrieveRequest.model_validate({
            "customer_id": "c", "client": "web", "data_type": "note", "llm_credentials": {},
            "raw_data": {"query_data": "q", "fs_namespace": ns},
        })
        return _build_state(req, {}, [])

    def test_a_proxy_minted_namespace_is_used(self):
        self.assertEqual(self._state("0123456789abcdef")["scratch"], {"fs_namespace": "0123456789abcdef"})

    def test_malformed_namespaces_are_ignored(self):
        for bad in ("short", "../../etc", "a" * 65, "has space here"):
            with self.subTest(ns=bad):
                self.assertEqual(self._state(bad)["scratch"], {})
        self.assertEqual(self._state(None)["scratch"], {})


class CompanionTests(unittest.TestCase):
    def test_generate_pdf_brings_its_companions(self):
        self.assertEqual(with_companions(["web_search", "generate_pdf"]),
                         ["web_search", "generate_pdf", "revise_pdf", "read_pdf_source"])
        self.assertEqual(with_companions(["web_search"]), ["web_search"])

    def test_explicit_lists_get_companions_and_uploads_enable_read_attachment(self):
        from models import RetrieveRequest
        from routes.retrieve import _enabled_builtin_tools

        types = {"n1": "TOOL_EXECUTOR"}
        enabled = _enabled_builtin_tools(types, {"n1": {"tools": ["generate_pdf"]}})
        self.assertEqual(enabled, ["generate_pdf", "revise_pdf", "read_pdf_source"])
        req = RetrieveRequest.model_validate({
            "customer_id": "c", "client": "web", "data_type": "note", "llm_credentials": {},
            "raw_data": {"query_data": "summarize", "files": [
                {"attachment_id": "u1", "s3_key": "customers/c/attachments/u1",
                 "media_type": "application/pdf", "origin": "uploaded"}]},
        })
        self.assertIn("read_attachment", _enabled_builtin_tools(types, {"n1": {"tools": []}}, req))
        # Without a TOOL_EXECUTOR nothing can execute built-ins.
        self.assertEqual(_enabled_builtin_tools({"n1": "RESPONSE_GENERATOR"}, {}, req), [])

    def test_implicit_enablement_never_includes_read_attachment(self):
        from graph.tools_runtime import all_builtin_tool_names

        names = all_builtin_tool_names()
        self.assertIn("revise_pdf", names)
        self.assertNotIn("read_attachment", names)


class ApplyEditsTests(unittest.TestCase):
    def test_exact_single_matches(self):
        text, problem = apply_edits("a b c", [{"find": "b", "replace": "B"}, {"find": "c", "replace": ""}])
        self.assertEqual((text, problem), ("a B ", None))

    def test_zero_or_several_matches_are_refused(self):
        _, problem = apply_edits("a b b", [{"find": "b", "replace": "x"}])
        self.assertIn("occurs 2 times", problem)
        _, problem = apply_edits("a b", [{"find": "zzz", "replace": "x"}])
        self.assertIn("does not occur", problem)
        _, problem = apply_edits("a", [])
        self.assertIn("non-empty", problem)
        _, problem = apply_edits("a", [{"find": "a"}])
        self.assertIn("'replace'", problem)

    def test_version_names(self):
        self.assertEqual(_next_filename("offer.pdf"), "offer (v2).pdf")
        self.assertEqual(_next_filename("offer (v2).pdf"), "offer (v3).pdf")
        self.assertEqual(_next_filename(None), "document (v2).pdf")


class RevisePdfTests(unittest.TestCase):
    def test_revision_changes_only_the_edited_span(self):
        conv = _Conversation()
        result = _run(RevisePdfTool().run({
            "artifact_id": "a1b2c3d4-0000-0000-0000-000000000001",
            "edits": [{"find": "1 March 2026", "replace": "15 April 2026"}],
        }, conv.context()))
        self.assertEqual(len(result.artifacts), 1, result.content)
        artifact = result.artifacts[0]
        self.assertEqual(artifact.filename, "offer (v2).pdf")
        # Saved under the CALLER's prefix with its new source.
        self.assertTrue(artifact.key.startswith("customers/recipient-2/attachments/"))
        new_source = conv.store.objects[f"{artifact.key}.source.md"].decode()
        self.assertEqual(new_source, "# Offer\n\nStart date: 15 April 2026.\n\nSalary: [Amount].")
        text = _pdf_text(conv.store.objects[artifact.key])
        self.assertIn("15 April 2026", text)
        self.assertIn("[Amount]", text)
        self.assertNotIn("1 March", text)
        # The original is untouched.
        self.assertEqual(conv.store.objects[conv.key], b"%PDF-1.4 original")

    def test_ids_outside_the_conversation_are_refused(self):
        conv = _Conversation()
        result = _run(RevisePdfTool().run(
            {"artifact_id": "someone-elses", "edits": [{"find": "a", "replace": "b"}]}, conv.context()))
        self.assertIn("not a PDF generated in this conversation", result.content)
        self.assertIn("offer.pdf", result.content)
        self.assertEqual(result.artifacts, [])

    def test_uploaded_files_have_no_source(self):
        conv = _Conversation()
        result = _run(ReadPdfSourceTool().run({"artifact_id": "up-1"}, conv.context()))
        self.assertIn("uploaded by the user", result.content)

    def test_ambiguous_find_creates_nothing(self):
        conv = _Conversation()
        before = dict(conv.store.objects)
        result = _run(RevisePdfTool().run({
            "artifact_id": "a1b2c3d4-0000-0000-0000-000000000001",
            "edits": [{"find": "a", "replace": "b"}],
        }, conv.context()))
        self.assertIn("each find must match exactly once", result.content)
        self.assertEqual(conv.store.objects, before)

    def test_pdfs_made_before_sources_were_stored(self):
        conv = _Conversation(source=None)
        for tool, args in ((RevisePdfTool(), {"edits": [{"find": "a", "replace": "b"}]}),
                           (ReadPdfSourceTool(), {})):
            result = _run(tool.run({"artifact_id": "a1b2c3d4-0000-0000-0000-000000000001", **args},
                                   conv.context()))
            self.assertIn("no source is stored for this file", result.content)

    def test_read_source_pages_through(self):
        long_source = "x" * 9000
        conv = _Conversation(source=long_source)
        first = _run(ReadPdfSourceTool().run({"artifact_id": "a1b2c3d4-0000-0000-0000-000000000001"},
                                             conv.context()))
        self.assertIn("continue with offset=7600", first.content)
        self.assertLessEqual(len(first.content), 8000)
        second = _run(ReadPdfSourceTool().run(
            {"artifact_id": "a1b2c3d4-0000-0000-0000-000000000001", "offset": 7600}, conv.context()))
        self.assertTrue(second.content.endswith("x" * 1400))
        self.assertNotIn("more remains", second.content)

    def test_a_separate_title_is_kept_in_the_stored_source(self):
        store = _MemoryStore()
        context = ToolContext(customer_id="c", store=store, key_template=_TEMPLATE)
        result = _run(gp.GeneratePdfTool().run(
            {"content_markdown": "Body.", "title": "Quarterly", "filename": "q.pdf"}, context))
        source = store.objects[result.artifacts[0].source_key].decode()
        self.assertEqual(source, "# Quarterly\n\nBody.")
        result = _run(gp.GeneratePdfTool().run(
            {"content_markdown": "# Quarterly\n\nBody.", "title": "quarterly", "filename": "q.pdf"}, context))
        self.assertEqual(store.objects[result.artifacts[0].source_key].decode(), "# Quarterly\n\nBody.")


class LongDocumentTests(unittest.TestCase):
    def _context(self, enabled=("generate_pdf", "fs_write")):
        store = _MemoryStore()
        prefix = "customers/c/agent-fs/ns123456/"
        context = ToolContext(customer_id="c", store=store, key_template=_TEMPLATE)
        context.runtime.update(request_runtime(
            {"customer_id": "c"}, {}, store=store, fs_prefix=prefix, enabled=enabled,
        ))
        context.runtime["fs_prefix"] = prefix
        context.runtime.pop("render_pdf")  # render in-thread in this test
        return context, store

    def test_three_appends_then_one_pdf(self):
        context, store = self._context()
        for i in (1, 2, 3):
            out = _run(FsWriteTool().run(
                {"path": "docs/report.md", "content": f"## Section {i}\n\nText of section {i}.\n\n",
                 "mode": "append"}, context))
            self.assertIn("Appended", out.content)
        result = _run(gp.GeneratePdfTool().run(
            {"source_paths": ["docs/report.md"], "filename": "report.pdf"}, context))
        self.assertEqual(len(result.artifacts), 1, result.content)
        text = _pdf_text(store.objects[result.artifacts[0].key])
        self.assertLess(text.index("Section 1"), text.index("Section 2"))
        self.assertLess(text.index("Section 2"), text.index("Section 3"))

    def test_appends_in_one_round_keep_their_order(self):
        context, store = self._context()

        async def round_():
            await asyncio.gather(*(FsWriteTool().run(
                {"path": "a.md", "content": f"{i};", "mode": "append"}, context) for i in range(5)))

        _run(round_())
        self.assertEqual(store.objects["customers/c/agent-fs/ns123456/a.md"], b"0;1;2;3;4;")

    def test_overwrite_is_still_the_default(self):
        context, store = self._context()
        _run(FsWriteTool().run({"path": "a.md", "content": "one"}, context))
        _run(FsWriteTool().run({"path": "a.md", "content": "two"}, context))
        self.assertEqual(store.objects["customers/c/agent-fs/ns123456/a.md"], b"two")
        bad = _run(FsWriteTool().run({"path": "a.md", "content": "x", "mode": "prepend"}, context))
        self.assertIn("mode must be", bad.content)

    def test_source_path_errors(self):
        context, store = self._context()
        _run(FsWriteTool().run({"path": "docs/a.md", "content": "A"}, context))
        cases = [
            ({"source_paths": ["../x"]}, "invalid path"),
            ({"source_paths": ["/etc/passwd"]}, "invalid path"),
            ({"source_paths": ["a/b/c/d/e/f/g/h/i.md"]}, "invalid path"),
            ({"source_paths": ["docs/missing.md"]}, "existing files: docs/a.md"),
            ({"source_paths": ["docs/a.md"], "content_markdown": "x"}, "not both"),
            ({}, "content_markdown is empty"),
        ]
        for args, expected in cases:
            with self.subTest(args=args):
                result = _run(gp.GeneratePdfTool().run({"filename": "r.pdf", **args}, context))
                self.assertIn(expected, result.content)
                self.assertEqual(result.artifacts, [])

    def test_source_paths_need_fs_write(self):
        context, _ = self._context(enabled=("generate_pdf",))
        result = _run(gp.GeneratePdfTool().run({"source_paths": ["docs/a.md"], "filename": "r.pdf"}, context))
        self.assertIn("not enabled here", result.content)

    def test_caps_apply_to_the_joined_text(self):
        context, store = self._context()
        context.runtime["pdf_limits"] = {"typst": {"max_chars": 10}}
        _run(FsWriteTool().run({"path": "a.md", "content": "x" * 8}, context))
        _run(FsWriteTool().run({"path": "b.md", "content": "y" * 8}, context))
        result = _run(gp.GeneratePdfTool().run({"source_paths": ["a.md", "b.md"], "filename": "r.pdf"}, context))
        self.assertEqual(result.details["pdf"]["reason"], "chars")


if __name__ == "__main__":
    unittest.main()


class ReservedNameScanTests(unittest.TestCase):
    def test_scan_finds_http_and_mcp_conflicts(self):
        import importlib.util
        import os

        path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "scripts", "scan_reserved_tool_names.py")
        spec = importlib.util.spec_from_file_location("scan_reserved_tool_names", path)
        scan_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(scan_module)

        class _Table:
            def __init__(self):
                self.calls = 0

            def scan(self, **kwargs):
                self.calls += 1
                if self.calls == 1:
                    return {"Items": [
                        {"customerId": "c1", "name": "revise_pdf", "provider": "http", "status": "active"},
                        {"customerId": "c2", "name": "crm", "provider": "http", "status": "active"},
                    ], "LastEvaluatedKey": {"k": 1}}
                return {"Items": [{"customerId": "c3", "name": "docs", "provider": "mcp",
                                   "status": "active", "discoveredTools": [{"name": "search"}]}]}

        report = scan_module.scan(_Table(), {"revise_pdf"})
        self.assertEqual(report["scanned"], 3)
        self.assertEqual([c["customerId"] for c in report["conflicts"]], ["c1"])
