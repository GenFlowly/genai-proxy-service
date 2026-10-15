"""
Unit tests for uploaded PDFs reaching the model (plans 4.1, 4.2, 4.3).

Run with `python -m unittest tests.test_llm_node_documents`.

The LLM itself is a recorder (as in tests.test_llm_node_prompt); the
messages it receives are then fed to each vendor SDK's own request builder,
so the assertions are on the payload that would be sent. Parsing runs in the
real worker child.
"""
import asyncio
import json
import subprocess
import sys
import unittest
from unittest import mock

from langchain_core.messages import AIMessage, HumanMessage

import graph.nodes.llm_node as llm_node_module
from graph import attachments, documents, pdf_worker
from graph.attachment_tools import ReadAttachmentTool
from graph.nodes.llm_node import make_llm_node
from graph_tools.base import ToolContext
from tests import pdf_fixtures
from tests.test_llm_node_prompt import _state

_KEY = "customers/owner-1/attachments/doc-0001"


class _Recorder:
    def __init__(self):
        self.messages = None

    async def ainvoke(self, messages):
        self.messages = messages
        return AIMessage(content="ok")


def _ref(key=_KEY, name="report.pdf", attachment_id="doc-0001"):
    return {"attachment_id": attachment_id, "s3_key": key, "media_type": "application/pdf",
            "filename": name, "origin": "uploaded"}


class _DocTestCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        attachments._BYTES.clear()
        self.store = pdf_fixtures.MemoryStore()
        patcher = mock.patch.object(attachments, "_store", return_value=self.store)
        patcher.start()
        self.addCleanup(patcher.stop)

    async def asyncTearDown(self):
        await pdf_worker.shutdown()

    async def _messages(self, provider, model, files=None, history=None):
        recorder = _Recorder()
        state = _state(llm_provider=provider, llm_model=model, query_files=files or [],
                       conversation_history=(history or []) + [{"role": "user", "content": "q"}])
        with mock.patch.object(llm_node_module, "_build_llm_and_structured", return_value=(recorder, None)), \
                mock.patch.object(llm_node_module, "credentials_for", return_value={}):
            await make_llm_node("RESPONSE_GENERATOR")(state)
        return recorder.messages

    @staticmethod
    def _blocks(message):
        return message.content if isinstance(message.content, list) else [{"type": "text", "text": message.content}]


class NativeDocumentTests(_DocTestCase):
    async def test_vendor_payloads_for_pdf_capable_models(self):
        self.store.objects[_KEY] = pdf_fixtures.text_pdf(3)

        messages = await self._messages("anthropic", "claude-test", [_ref()])
        current = self._blocks(messages[-1])
        self.assertEqual(current[0]["type"], "file")
        self.assertEqual(current[0]["filename"], "report.pdf")
        from langchain_anthropic import ChatAnthropic

        payload = ChatAnthropic(model="claude-test", api_key="k")._get_request_payload(messages)
        block = payload["messages"][-1]["content"][0]
        self.assertEqual(block["type"], "document")
        self.assertEqual(block["source"]["media_type"], "application/pdf")
        self.assertEqual(block["cache_control"], {"type": "ephemeral"})
        breakpoints = json.dumps(payload).count('"cache_control"')
        self.assertLessEqual(breakpoints, 4)

        from langchain_openai import ChatOpenAI

        messages = await self._messages("openai", "gpt-4o", [_ref()])
        payload = ChatOpenAI(model="gpt-4o", api_key="k")._get_request_payload(messages)
        block = payload["messages"][-1]["content"][0]
        self.assertEqual(block["type"], "file")
        self.assertEqual(block["file"]["filename"], "report.pdf")

        messages = await self._messages("openai", "gpt-5", [_ref()])
        payload = ChatOpenAI(model="gpt-5", api_key="k", use_responses_api=True)._get_request_payload(messages)
        self.assertEqual(payload["input"][-1]["content"][0]["type"], "input_file")

        from langchain_google_genai.chat_models import _parse_chat_history

        messages = await self._messages("gemini", "gemini-2.5-pro", [_ref()])
        _, contents = _parse_chat_history(messages)
        inline = [p.inline_data for p in contents[-1].parts if p.inline_data]
        self.assertEqual(inline[0].mime_type, "application/pdf")

    async def test_other_providers_get_the_text(self):
        self.store.objects[_KEY] = pdf_fixtures.text_pdf(3)
        for provider, model in (("deepseek", "deepseek-chat"), ("groq", "llama-3.3-70b-versatile"),
                                ("mistral", "mistral-large-latest"), ("xai", "grok-4")):
            with self.subTest(provider=provider):
                messages = await self._messages(provider, model, [_ref()])
                blocks = self._blocks(messages[-1])
                self.assertNotIn("file", [b.get("type") for b in blocks])
                text = blocks[0]["text"]
                self.assertIn('<document name="report.pdf" pages="3" id="doc-0001">', text)
                self.assertIn("Page 2 text on page 2.", text)

    async def test_a_pdf_too_large_for_the_budget_goes_as_text(self):
        self.store.objects[_KEY] = pdf_fixtures.text_pdf(2)
        with mock.patch.object(documents, "REQUEST_ATTACHMENT_BUDGET_B64", 100):
            messages = await self._messages("anthropic", "claude-test", [_ref()])
        blocks = self._blocks(messages[-1])
        self.assertNotIn("file", [b.get("type") for b in blocks])
        self.assertIn("<document", blocks[0]["text"])

    async def test_more_than_100_pages_go_as_text(self):
        self.store.objects[_KEY] = pdf_fixtures.text_pdf(101)
        messages = await self._messages("anthropic", "claude-test", [_ref()])
        blocks = self._blocks(messages[-1])
        self.assertNotIn("file", [b.get("type") for b in blocks])

    def test_native_documents_shrink_the_image_budget(self):
        from graph.image_normalize import limits_for_request

        full = limits_for_request("anthropic", 2)
        shared = limits_for_request("anthropic", 2, reserved_bytes=20 * 1024 * 1024)
        self.assertLess(shared.max_base64_bytes, full.max_base64_bytes)
        self.assertEqual(documents.budget_for("gemini", 0).native_b64_left, 15 * 1024 * 1024)
        self.assertLess(documents.budget_for("gemini", 4).native_b64_left, 15 * 1024 * 1024)


class DifficultDocumentTests(_DocTestCase):
    async def test_scanned_pdfs_become_page_images_for_vision_models(self):
        self.store.objects[_KEY] = pdf_fixtures.scanned_pdf(2)
        with mock.patch("graph.capabilities.supports_pdf_input", return_value=False), \
                mock.patch("graph.capabilities.supports_vision", return_value=True):
            messages = await self._messages("openai", "vision-model", [_ref()])
        blocks = self._blocks(messages[-1])
        images = [b for b in blocks if b.get("type") == "image_url"]
        self.assertEqual(len(images), 2)
        self.assertTrue(images[0]["image_url"]["url"].startswith("data:image/jpeg;base64,"))

    async def test_scanned_pdfs_get_a_note_on_text_only_models(self):
        self.store.objects[_KEY] = pdf_fixtures.scanned_pdf(2)
        messages = await self._messages("deepseek", "deepseek-chat", [_ref()])
        self.assertIn("no extractable text", self._blocks(messages[-1])[0]["text"])

    async def test_encrypted_pdfs_fail_with_a_user_message(self):
        self.store.objects[_KEY] = pdf_fixtures.encrypted_pdf()
        with self.assertRaises(attachments.DocumentError) as ctx:
            await self._messages("anthropic", "claude-test", [_ref()])
        self.assertIn("password-protected", str(ctx.exception))
        from streaming import user_facing_llm_error

        kind, message = user_facing_llm_error(ctx.exception, "anthropic")
        self.assertEqual(kind, "attachment_error")
        self.assertIn("report.pdf", message)

    async def test_a_busy_parser_gives_a_note(self):
        self.store.objects[_KEY] = pdf_fixtures.text_pdf(1)

        async def busy(*args, **kwargs):
            return {"status": "error", "kind": "busy"}, b""

        with mock.patch.object(pdf_worker, "parse_pdf", busy):
            messages = await self._messages("anthropic", "claude-test", [_ref()])
        self.assertIn("could not be read right now", self._blocks(messages[-1])[0]["text"])
        self.assertNotIn(attachments.sidecar_key(_KEY), self.store.objects)

    async def test_the_sidecar_is_derived_and_reused(self):
        self.store.objects[_KEY] = pdf_fixtures.text_pdf(2)
        doc = await attachments.load(_ref())
        self.assertEqual((doc.status, doc.pages), ("ok", 2))
        key = f"{_KEY}.derived/text-v1.json"
        self.assertIn(key, self.store.objects)
        self.assertEqual(self.store.tags[key], {"retention": "derived"})

        async def must_not_parse(*args, **kwargs):
            raise AssertionError("the sidecar should have been used")

        with mock.patch.object(pdf_worker, "parse_pdf", must_not_parse):
            again = await attachments.load(_ref())
        self.assertEqual(again.texts, doc.texts)

    async def test_parsing_stops_the_idle_render_child(self):
        await pdf_worker.render_pdf({"renderer": "x2p_v1", "markdown": "hi", "title": None, "filename": "a.pdf"})
        self.assertIsNotNone(pdf_worker.get_worker()._warm)
        self.store.objects[_KEY] = pdf_fixtures.text_pdf(1)
        await attachments.load(_ref())
        self.assertIsNone(pdf_worker.get_worker()._warm)


class HistoryReplayTests(_DocTestCase):
    def _history(self, ref):
        return [
            {"role": "user", "content": "summarize this", "files": [ref]},
            {"role": "assistant", "content": "It says hello."},
        ]

    async def test_later_turns_get_text_not_the_file(self):
        self.store.objects[_KEY] = pdf_fixtures.text_pdf(30)
        messages = await self._messages("anthropic", "claude-test", history=self._history(_ref()))
        earlier = [m for m in messages if isinstance(m, HumanMessage)][0]
        blocks = self._blocks(earlier)
        self.assertNotIn("file", [b.get("type") for b in blocks])
        self.assertTrue(any("<document" in (b.get("text") or "") for b in blocks))

    async def test_long_documents_become_a_stub(self):
        self.store.objects[_KEY] = pdf_fixtures.text_pdf(300, lines=8)
        messages = await self._messages("anthropic", "claude-test", history=self._history(_ref()))
        earlier = [m for m in messages if isinstance(m, HumanMessage)][0]
        text = " ".join(b.get("text") or "" for b in self._blocks(earlier))
        self.assertIn("[document report.pdf, 300 pages, id=doc-0001", text)
        self.assertIn("read_attachment", text)


class ReadAttachmentTests(_DocTestCase):
    def _context(self, files):
        context = ToolContext(customer_id="recipient", store=self.store)
        context.runtime["conversation_files"] = {
            f["attachment_id"]: {k: v for k, v in f.items() if k != "attachment_id"} for f in files
        }
        return context

    async def test_reads_only_the_requested_pages(self):
        self.store.objects[_KEY] = pdf_fixtures.text_pdf(8)
        out = await ReadAttachmentTool().run({"attachment_id": "doc-0001", "pages": "3-5"},
                                             self._context([_ref()]))
        self.assertIn("pages 3-5", out.content)
        self.assertIn("Page 3 text", out.content)
        self.assertIn("Page 5 text", out.content)
        self.assertNotIn("Page 2 text", out.content)
        self.assertNotIn("Page 6 text", out.content)

    async def test_refuses_ids_outside_the_conversation_and_generated_files(self):
        generated = {**_ref(attachment_id="gen-1"), "origin": "generated"}
        context = self._context([_ref(), generated])
        out = await ReadAttachmentTool().run({"attachment_id": "elsewhere"}, context)
        self.assertIn("not a document attached", out.content)
        self.assertIn("report.pdf", out.content)
        out = await ReadAttachmentTool().run({"attachment_id": "gen-1"}, context)
        self.assertIn("not a document attached", out.content)

    async def test_results_stay_under_the_spill_threshold(self):
        self.store.objects[_KEY] = pdf_fixtures.text_pdf(60, lines=8)
        out = await ReadAttachmentTool().run({"attachment_id": "doc-0001"}, self._context([_ref()]))
        self.assertLessEqual(len(out.content), 8_000)
        self.assertIn("continue with pages=", out.content)

    async def test_bad_page_specs(self):
        self.store.objects[_KEY] = pdf_fixtures.text_pdf(2)
        context = self._context([_ref()])
        for spec, expected in (("x", "must look like"), ("5", "has pages 1-2"), ("2-1", "has pages 1-2")):
            out = await ReadAttachmentTool().run({"attachment_id": "doc-0001", "pages": spec}, context)
            self.assertIn(expected, out.content)


class ServerProcessTests(unittest.TestCase):
    def test_the_server_never_imports_pdfium(self):
        code = (
            "import sys\n"
            "import graph.documents, graph.attachments, graph.attachment_tools, graph.nodes.llm_node\n"
            "sys.exit(1 if 'pypdfium2' in sys.modules else 0)\n"
        )
        import os

        app_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        self.assertEqual(subprocess.run([sys.executable, "-c", code], cwd=app_dir, timeout=120).returncode, 0)

    def test_subagents_inherit_the_conversation_files(self):
        from graph import subagent

        captured = {}

        class _Graph:
            async def ainvoke(self, state, config=None):
                captured.update(state)
                return {"generated_response": "done", "usage": {}, "trace": [], "generated_artifacts": []}

        parent = {"customer_id": "c", "llm_provider": "openai", "conversation_files": [_ref()],
                  "locale": "de-DE", "pdf_renderer": "typst", "pdf_script_route": None}
        with mock.patch.object(subagent, "_get_child_graph", return_value=_Graph()):
            asyncio.run(subagent.run_subagent(parent, {"name": "general"}, "read it", 1))
        self.assertEqual(captured["conversation_files"], [_ref()])
        self.assertEqual(captured["query_files"], [])
        self.assertEqual((captured["locale"], captured["pdf_renderer"]), ("de-DE", "typst"))


if __name__ == "__main__":
    unittest.main()
