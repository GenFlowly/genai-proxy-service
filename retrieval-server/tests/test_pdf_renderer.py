"""
Unit tests for graph/pdf_renderer.py (plan 2.1, one renderer since 5.2) and
the per-request generate_pdf spec (plan 2.7).

Run with `python -m unittest tests.test_pdf_renderer`.
"""
import asyncio
import io
import os
import unittest
from unittest import mock

from pypdf import PdfReader

from graph import pdf_renderer
from graph_tools.base import SpecContext, ToolContext
from graph_tools.tools.generate_pdf import GeneratePdfTool

_OLD_ENV = ("PDF_RENDERER_CANARY", "PDF_RENDERER_CANARY_CUSTOMERS", "PDF_RENDERER_SCRIPT_ROUTE")


def _env(**values):
    clean = {k: v for k, v in os.environ.items() if not k.startswith(("PDF_RENDERER", "PDF_TYPST"))}
    clean.update(values)
    return mock.patch.dict(os.environ, clean, clear=True)


class _RendererTestCase(unittest.TestCase):
    def setUp(self):
        # Each warning is logged once per process; start every test fresh.
        pdf_renderer._warned.clear()
        self.addCleanup(pdf_renderer._warned.clear)


class RendererPinTests(_RendererTestCase):
    def test_typst_is_the_only_renderer(self):
        self.assertEqual(pdf_renderer.RENDERERS, ("typst",))
        with _env():
            self.assertEqual(pdf_renderer.pin(), {"pdf_renderer": "typst"})
        with _env(PDF_RENDERER="typst"), self.assertNoLogs("graph.pdf_renderer", level="WARNING"):
            self.assertEqual(pdf_renderer.pin(), {"pdf_renderer": "typst"})

    def test_an_old_x2p_env_value_is_tolerated_with_one_warning(self):
        with _env(PDF_RENDERER="x2p_v1"):
            with self.assertLogs("graph.pdf_renderer", level="WARNING") as logs:
                self.assertEqual(pdf_renderer.pin(), {"pdf_renderer": "typst"})
            self.assertEqual(len(logs.output), 1)
            self.assertIn("PDF_RENDERER=x2p_v1", logs.output[0])
            with self.assertNoLogs("graph.pdf_renderer", level="WARNING"):  # once per process
                self.assertEqual(pdf_renderer.pin(), {"pdf_renderer": "typst"})

    def test_unknown_values_fall_back_without_logging_the_value(self):
        with _env(PDF_RENDERER="weasy-secret"), \
                self.assertLogs("graph.pdf_renderer", level="WARNING") as logs:
            self.assertEqual(pdf_renderer.pin(), {"pdf_renderer": "typst"})
        self.assertNotIn("weasy-secret", "".join(logs.output))

    def test_canary_and_script_route_settings_are_obsolete(self):
        with _env(PDF_RENDERER_CANARY="x2p_v1", PDF_RENDERER_CANARY_CUSTOMERS="c1, c2",
                  PDF_RENDERER_SCRIPT_ROUTE="typst"):
            with self.assertLogs("graph.pdf_renderer", level="WARNING") as logs:
                self.assertEqual(pdf_renderer.pin(), {"pdf_renderer": "typst"})
            for name in _OLD_ENV:
                self.assertTrue(any(name in line for line in logs.output), name)
            self.assertNotIn("c1", "".join(logs.output))
            with self.assertNoLogs("graph.pdf_renderer", level="WARNING"):
                pdf_renderer.pin()
            self.assertFalse(hasattr(pdf_renderer, "script_route"))
            self.assertFalse(hasattr(pdf_renderer, "fonts_cover"))

    def test_runs_pinned_to_the_removed_renderer_render_with_typst(self):
        # Plan 5.2: a durable run enqueued before the removal deploy and
        # recovered after it (plan 0.1 keeps the DBOS app version) still
        # carries "x2p_v1"; it renders with Typst instead of failing.
        with _env():
            for state in (
                {"customer_id": "c1", "pdf_renderer": "x2p_v1", "pdf_script_route": "typst"},
                {"customer_id": "c1", "pdf_renderer": "x2p_v1", "pdf_script_route": None},
                {"customer_id": "c1", "pdf_renderer": "something-else"},
                {"customer_id": "c1"},  # enqueued before pinning existed: resolved now
                {"customer_id": "c1", "pdf_renderer": "typst"},
            ):
                with self.subTest(state=state):
                    self.assertEqual(pdf_renderer.pinned_or_resolved(state), {"pdf_renderer": "typst"})

    def test_typst_caps_are_configurable(self):
        with _env(PDF_TYPST_MAX_CHARS="300000", PDF_TYPST_MAX_TABLE_ROWS="2500"):
            limits = pdf_renderer.limits()
        self.assertEqual(limits, {"typst": {"max_chars": 300000, "max_table_rows": 2500}})
        with _env():
            self.assertEqual(pdf_renderer.limits(), {"typst": {"max_chars": 150_000, "max_table_rows": 1_000}})
        with _env(PDF_TYPST_MAX_CHARS="lots", PDF_TYPST_MAX_TABLE_ROWS="-5"), \
                self.assertLogs("graph.pdf_renderer", level="WARNING"):
            self.assertEqual(pdf_renderer.limits()["typst"], {"max_chars": 150_000, "max_table_rows": 1_000})


class RetrieveRequestPinningTests(_RendererTestCase):
    def test_retrieve_overwrites_a_caller_supplied_renderer(self):
        from models import RetrieveRequest

        req = RetrieveRequest.model_validate({
            "customer_id": "c1", "client": "web", "data_type": "note",
            "raw_data": {"query_data": "hi"}, "llm_credentials": {},
            "pdf_renderer": "x2p_v1",
        })
        with _env():
            pinned = req.model_copy(update=pdf_renderer.pin())
        self.assertEqual(pinned.pdf_renderer, "typst")

    def test_declared_fields_survive_a_durable_rebuild(self):
        from models import RetrieveRequest, RunRequest

        run = RunRequest.model_validate({
            "customer_id": "c1", "client": "web", "data_type": "note",
            "raw_data": {"query_data": "hi", "locale": "de-DE", "fs_namespace": "abcdef0123456789"},
            "pdf_renderer": "typst",
        })
        rebuilt = RetrieveRequest.model_validate({**run.model_dump(exclude={"run_id"}), "llm_credentials": {}})
        self.assertEqual(rebuilt.pdf_renderer, "typst")
        self.assertEqual(rebuilt.raw_data.locale, "de-DE")
        self.assertEqual(rebuilt.raw_data.fs_namespace, "abcdef0123456789")

    def test_a_run_enqueued_before_the_removal_renders_with_typst(self):
        # The stored input of a run POST /runs enqueued while x2p_v1 and the
        # script route existed, rebuilt the way runs._agent_run_body rebuilds
        # it on recovery, then through the request runtime into the tool.
        from graph.tools_runtime import request_runtime, spec_context_for
        from models import RetrieveRequest
        from routes.retrieve import _build_state
        from tests import pdf_fixtures

        stored = {
            "customer_id": "c1", "client": "web", "data_type": "conversation",
            "raw_data": {"query_data": "make me a PDF"}, "llm_provider": "anthropic",
            "agentic": True, "pdf_renderer": "x2p_v1", "pdf_script_route": "typst",
        }
        req = RetrieveRequest.model_validate({**stored, "llm_credentials": {}, "stream": True})
        self.assertFalse(hasattr(req, "pdf_script_route"))
        state = _build_state(req, {}, ["generate_pdf"])
        self.assertEqual(state["pdf_renderer"], "x2p_v1")
        self.assertNotIn("pdf_script_route", state)

        store = pdf_fixtures.MemoryStore()
        with _env():
            runtime = request_runtime(state, {}, store=store, fs_prefix=None, enabled=["generate_pdf"])
            spec = GeneratePdfTool().spec_for(spec_context_for(state, ["generate_pdf"]))
        self.assertEqual(runtime["pdf_renderer"], "typst")
        self.assertEqual(set(runtime["pdf_limits"]), {"typst"})
        self.assertNotIn("pdf_script_route", runtime)
        self.assertNotIn("pdf_fonts_cover", runtime)
        self.assertIn("right-to-left", spec["description"])
        self.assertIn("page_size", spec["parameters"]["properties"])

        context = ToolContext(customer_id="c1", store=store,
                              key_template="customers/{customer_id}/attachments/{artifact_id}")
        context.runtime.update(runtime)
        context.runtime.pop("render_pdf")  # render in a thread here; test_pdf_worker covers the child
        recorded = []
        context.runtime["record_pdf_stats"] = recorded.append
        result = asyncio.run(GeneratePdfTool().run(
            {"content_markdown": "# Offer\n\nمرحبا Łódź", "filename": "offer.pdf"}, context))
        self.assertEqual(len(result.artifacts), 1, result.content)
        pdf = store.objects[result.artifacts[0].key]
        self.assertTrue(str(PdfReader(io.BytesIO(pdf)).metadata.get("/Creator")).startswith("Typst "))
        self.assertEqual([s["renderer"] for s in recorded], ["typst"])


class PerRequestDescriptionTests(_RendererTestCase):
    def _spec(self, enabled, renderer="typst"):
        ctx = SpecContext(enabled=frozenset(enabled), host={
            "pdf_renderer": renderer,
            "pdf_limits": {"typst": {"max_chars": 300_000, "max_table_rows": 2_500}},
        })
        return GeneratePdfTool().spec_for(ctx)

    def test_without_fs_tools(self):
        spec = GeneratePdfTool().spec_for(SpecContext(enabled=frozenset({"generate_pdf"}), host={}))
        text = spec["description"]
        self.assertIn("right-to-left", text)
        self.assertIn("150,000 characters", text)
        self.assertNotIn("Only Western European", text)
        self.assertNotIn("A4 portrait", text)
        self.assertNotIn("fs_write", text)
        self.assertNotIn("revise_pdf", text)
        props = spec["parameters"]["properties"]
        self.assertNotIn("source_paths", props)
        self.assertEqual(props["page_size"]["enum"], ["A4", "Letter", "Legal"])
        self.assertEqual(props["orientation"]["enum"], ["portrait", "landscape"])
        self.assertEqual(spec["parameters"]["required"], ["content_markdown", "filename"])
        # Without a request the static spec says the same.
        self.assertEqual(GeneratePdfTool().spec_for(None)["description"], text)

    def test_with_fs_write(self):
        spec = self._spec({"generate_pdf", "fs_write"})
        text = spec["description"]
        self.assertIn("fs_write", text)
        self.assertIn("300,000 characters", text)
        self.assertNotIn("revise_pdf", text)
        self.assertIn("source_paths", spec["parameters"]["properties"])
        self.assertEqual(spec["parameters"]["required"], ["filename"])

    def test_revise_mention(self):
        text = self._spec({"generate_pdf", "revise_pdf"})["description"]
        self.assertIn("revise_pdf", text)
        self.assertNotIn("second renderer", text)

    def test_a_request_pinned_to_the_removed_renderer_gets_the_typst_spec(self):
        self.assertEqual(self._spec({"generate_pdf"}, renderer="x2p_v1"), self._spec({"generate_pdf"}))

    def test_specs_are_built_per_request_through_the_runtime(self):
        from graph.tools_runtime import spec_context_for, specs_for

        for pinned in ("typst", "x2p_v1"):
            with self.subTest(pinned=pinned):
                state = {"customer_id": "c1", "pdf_renderer": pinned}
                with _env():
                    specs = specs_for(["generate_pdf", "fs_write"], "c1",
                                      spec_context_for(state, ["generate_pdf", "fs_write"]))
                pdf = next(s for s in specs if s["name"] == "generate_pdf")
                self.assertIn("source_paths", pdf["parameters"]["properties"])
                self.assertIn("page_size", pdf["parameters"]["properties"])
                self.assertIn("right-to-left", pdf["description"])


if __name__ == "__main__":
    unittest.main()
