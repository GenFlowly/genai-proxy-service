"""
Unit tests for graph/pdf_renderer.py (plan 2.1) and the per-request
generate_pdf spec (plan 2.7).

Run with `python -m unittest tests.test_pdf_renderer`.
"""
import os
import unittest
from unittest import mock

from graph import pdf_renderer
from graph_tools.base import SpecContext
from graph_tools.tools import pdf_charsets
from graph_tools.tools.generate_pdf import GeneratePdfTool


def _env(**values):
    clean = {k: v for k, v in os.environ.items() if not k.startswith("PDF_RENDERER")}
    clean.update(values)
    return mock.patch.dict(os.environ, clean, clear=True)


class RendererPrecedenceTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(pdf_renderer, "typst_available", return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_default_is_x2p(self):
        with _env():
            self.assertEqual(pdf_renderer.pin("c1"), {"pdf_renderer": "x2p_v1", "pdf_script_route": None})

    def test_env_default_and_canary_list(self):
        with _env(PDF_RENDERER="x2p_v1", PDF_RENDERER_CANARY="typst",
                  PDF_RENDERER_CANARY_CUSTOMERS="c1, c2"):
            self.assertEqual(pdf_renderer.base_renderer("c2"), "typst")
            self.assertEqual(pdf_renderer.base_renderer("c3"), "x2p_v1")
            self.assertEqual(pdf_renderer.base_renderer(None), "x2p_v1")
        with _env(PDF_RENDERER="typst"):
            self.assertEqual(pdf_renderer.base_renderer("c9"), "typst")

    def test_unknown_values_fall_back_with_a_warning(self):
        with _env(PDF_RENDERER="weasy", PDF_RENDERER_SCRIPT_ROUTE="weasy"), \
                self.assertLogs("graph.pdf_renderer", level="WARNING"):
            self.assertEqual(pdf_renderer.pin("c1"), {"pdf_renderer": "x2p_v1", "pdf_script_route": None})

    def test_typst_unavailable_falls_back(self):
        with _env(PDF_RENDERER_CANARY="typst", PDF_RENDERER_CANARY_CUSTOMERS="c1",
                  PDF_RENDERER_SCRIPT_ROUTE="typst"), \
                mock.patch.object(pdf_renderer, "typst_available", return_value=False), \
                self.assertLogs("graph.pdf_renderer", level="WARNING"):
            self.assertEqual(pdf_renderer.pin("c1"), {"pdf_renderer": "x2p_v1", "pdf_script_route": None})

    def test_script_route_applies_only_to_undrawable_letters(self):
        pinned = {"pdf_renderer": "x2p_v1", "pdf_script_route": "typst"}
        with mock.patch.object(pdf_renderer, "fonts_cover", return_value=True):
            arabic = pdf_charsets.find_undrawable("مرحبا")
            self.assertEqual(pdf_renderer.resolve("c1", arabic, pinned=pinned), "typst")
            emoji = pdf_charsets.find_undrawable("Done ⚠️ ✅")
            self.assertEqual(pdf_renderer.resolve("c1", emoji, pinned=pinned), "x2p_v1")
            latin = pdf_charsets.find_undrawable("plain text")
            self.assertEqual(pdf_renderer.resolve("c1", latin, pinned=pinned), "x2p_v1")
        with mock.patch.object(pdf_renderer, "fonts_cover", return_value=False):
            self.assertEqual(pdf_renderer.resolve("c1", arabic, pinned=pinned), "x2p_v1")
        off = {"pdf_renderer": "x2p_v1", "pdf_script_route": None}
        self.assertEqual(pdf_renderer.resolve("c1", arabic, pinned=off), "x2p_v1")

    def test_a_pinned_run_keeps_its_renderer_after_an_env_flip(self):
        with _env(PDF_RENDERER="typst"):
            pinned = pdf_renderer.pin("c1")
        with _env(PDF_RENDERER="x2p_v1"):
            state = {"customer_id": "c1", **pinned}
            self.assertEqual(pdf_renderer.pinned_or_resolved(state)["pdf_renderer"], "typst")
            # A run enqueued before pinning existed resolves now.
            self.assertEqual(pdf_renderer.pinned_or_resolved({"customer_id": "c1"})["pdf_renderer"], "x2p_v1")

    def test_runs_pinned_to_a_removed_renderer_fall_back_to_typst(self):
        # Plan 5.2: once xhtml2pdf is removed, a recovered run pinned to
        # x2p_v1 renders with Typst instead of failing.
        with _env(), mock.patch.object(pdf_renderer, "x2p_available", return_value=False):
            self.assertEqual(pdf_renderer.pin("c1")["pdf_renderer"], "typst")
            state = {"customer_id": "c1", "pdf_renderer": "x2p_v1", "pdf_script_route": None}
            self.assertEqual(pdf_renderer.pinned_or_resolved(state)["pdf_renderer"], "typst")

    def test_typst_caps_are_configurable(self):
        with _env(PDF_TYPST_MAX_CHARS="300000", PDF_TYPST_MAX_TABLE_ROWS="2500"):
            limits = pdf_renderer.limits()
        self.assertEqual(limits["typst"], {"max_chars": 300000, "max_table_rows": 2500})
        self.assertEqual(limits["x2p_v1"], {"max_chars": 150_000, "max_table_rows": 1_000})
        with _env(PDF_TYPST_MAX_CHARS="lots"):
            self.assertEqual(pdf_renderer.limits()["typst"]["max_chars"], 150_000)


class RetrieveRequestPinningTests(unittest.TestCase):
    def test_retrieve_overwrites_a_caller_supplied_renderer(self):
        from models import RetrieveRequest

        req = RetrieveRequest.model_validate({
            "customer_id": "c1", "client": "web", "data_type": "note",
            "raw_data": {"query_data": "hi"}, "llm_credentials": {},
            "pdf_renderer": "typst",
        })
        with _env():
            pinned = req.model_copy(update=pdf_renderer.pin(req.customer_id))
        self.assertEqual(pinned.pdf_renderer, "x2p_v1")

    def test_declared_fields_survive_a_durable_rebuild(self):
        from models import RetrieveRequest, RunRequest

        run = RunRequest.model_validate({
            "customer_id": "c1", "client": "web", "data_type": "note",
            "raw_data": {"query_data": "hi", "locale": "de-DE", "fs_namespace": "abcdef0123456789"},
            "pdf_renderer": "typst", "pdf_script_route": "typst",
        })
        rebuilt = RetrieveRequest.model_validate({**run.model_dump(exclude={"run_id"}), "llm_credentials": {}})
        self.assertEqual((rebuilt.pdf_renderer, rebuilt.pdf_script_route), ("typst", "typst"))
        self.assertEqual(rebuilt.raw_data.locale, "de-DE")
        self.assertEqual(rebuilt.raw_data.fs_namespace, "abcdef0123456789")


class PerRequestDescriptionTests(unittest.TestCase):
    def _spec(self, enabled, renderer="x2p_v1", route=None):
        ctx = SpecContext(enabled=frozenset(enabled), host={
            "pdf_renderer": renderer, "pdf_script_route": route,
            "pdf_limits": {"typst": {"max_chars": 300_000, "max_table_rows": 2_500}},
        })
        return GeneratePdfTool().spec_for(ctx)

    def test_x2p_without_fs_tools(self):
        spec = self._spec({"generate_pdf"})
        text = spec["description"]
        self.assertIn("Only Western European", text)
        self.assertIn("A4 portrait", text)
        self.assertIn("150,000 characters", text)
        self.assertNotIn("fs_write", text)
        self.assertNotIn("revise_pdf", text)
        self.assertNotIn("source_paths", spec["parameters"]["properties"])
        self.assertNotIn("page_size", spec["parameters"]["properties"])
        self.assertEqual(spec["parameters"]["required"], ["content_markdown", "filename"])
        self.assertNotIn("request changes afterwards", text)

    def test_typst_with_fs_write(self):
        spec = self._spec({"generate_pdf", "fs_write"}, renderer="typst")
        text = spec["description"]
        self.assertIn("right-to-left", text)
        self.assertIn("fs_write", text)
        self.assertIn("300,000 characters", text)
        self.assertNotIn("revise_pdf", text)
        props = spec["parameters"]["properties"]
        self.assertIn("source_paths", props)
        self.assertEqual(props["page_size"]["enum"], ["A4", "Letter", "Legal"])
        self.assertEqual(spec["parameters"]["required"], ["filename"])

    def test_script_route_and_revise_mentions(self):
        text = self._spec({"generate_pdf", "revise_pdf"}, route="typst")["description"]
        self.assertIn("second renderer", text)
        self.assertNotIn("Only Western European", text)
        self.assertIn("revise_pdf", text)

    def test_specs_are_built_per_request_through_the_runtime(self):
        from graph.tools_runtime import spec_context_for, specs_for

        state = {"customer_id": "c1", "pdf_renderer": "typst", "pdf_script_route": None}
        with mock.patch.object(pdf_renderer, "typst_available", return_value=True):
            specs = specs_for(["generate_pdf", "fs_write"], "c1",
                              spec_context_for(state, ["generate_pdf", "fs_write"]))
        pdf = next(s for s in specs if s["name"] == "generate_pdf")
        self.assertIn("source_paths", pdf["parameters"]["properties"])
        self.assertIn("page_size", pdf["parameters"]["properties"])


if __name__ == "__main__":
    unittest.main()
