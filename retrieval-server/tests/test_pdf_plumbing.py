"""
Unit tests for the plumbing around generated files.

Run with `python -m unittest tests.test_pdf_plumbing`.

- display_args: long tool arguments shortened in thinking steps (plan 1.9);
- storage: object tags and Content-Disposition on every write (1.13, 1.15),
  and the source sidecar save_artifact stores next to a PDF (1.9, 1.16);
- the /retrieve keepalive (1.7);
- pdf_metrics.record never raises (1.3).
"""
import asyncio
import json
import unittest
from unittest import mock

from graph.display_args import display_args, display_value
from graph_tools.base import Artifact, ToolContext
from graph_tools.storage import LocalDiskArtifactStore, S3ArtifactStore, content_disposition


class DisplayArgsTests(unittest.TestCase):
    def test_short_arguments_are_shown_in_full(self):
        args = {"query": "hotels owned by MGM", "topic": "news", "n": 3}
        self.assertEqual(display_args(args), args)
        self.assertEqual(display_args(None), {})

    def test_long_strings_become_a_head_and_a_length(self):
        shown = display_args({"content_markdown": "x" * 125_000, "filename": "r.pdf"})
        self.assertEqual(shown["filename"], "r.pdf")
        self.assertEqual(shown["content_markdown"], "x" * 120 + "... (125,000 chars)")

    def test_nested_values_are_shortened_too(self):
        shown = display_value([{"calls": [{"args": {"text": "y" * 400}}]}, ("z" * 301,)])
        self.assertTrue(shown[0]["calls"][0]["args"]["text"].endswith("(400 chars)"))
        self.assertTrue(shown[1][0].endswith("(301 chars)"))


class ContentDispositionTests(unittest.TestCase):
    def test_ascii_names(self):
        self.assertEqual(
            content_disposition("report.pdf"),
            "inline; filename=\"report.pdf\"; filename*=UTF-8''report.pdf",
        )

    def test_accented_names_keep_a_readable_fallback(self):
        header = content_disposition("Résumé  José Müller.pdf")
        self.assertIn('filename="Resume Jose Muller.pdf"', header)
        self.assertIn("filename*=UTF-8''R%C3%A9sum%C3%A9%20%20Jos%C3%A9%20M%C3%BCller.pdf", header)

    def test_names_with_no_ascii_fall_back_to_download(self):
        self.assertIn('filename="download.pdf"', content_disposition("报告.pdf"))
        self.assertIn('filename="download"', content_disposition("报告"))

    def test_no_header_injection(self):
        header = content_disposition('a"b\\c\r\nX-Evil: 1.pdf')
        self.assertNotIn("\r", header)
        self.assertNotIn("\n", header)
        fallback = header.split('filename="', 1)[1].split('"', 1)[0]
        self.assertNotIn('"', fallback)
        self.assertNotIn("\\", fallback)


class StoreTests(unittest.TestCase):
    def test_s3_put_sends_tags_and_disposition(self):
        client = mock.Mock()
        store = S3ArtifactStore("bucket")
        store._client = client
        store.put("k", b"%PDF", "application/pdf", tags={"retention": "pending"}, filename="r.pdf")
        kwargs = client.put_object.call_args.kwargs
        self.assertEqual(kwargs["Tagging"], "retention=pending")
        self.assertEqual(kwargs["ContentDisposition"], content_disposition("r.pdf"))
        self.assertEqual(kwargs["ContentType"], "application/pdf")

    def test_s3_put_without_extras_is_unchanged(self):
        client = mock.Mock()
        store = S3ArtifactStore("bucket")
        store._client = client
        store.put("k", b"x", "text/plain")
        self.assertEqual(set(client.put_object.call_args.kwargs), {"Bucket", "Key", "Body", "ContentType"})

    def test_local_disk_store_accepts_and_ignores_the_extras(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            store = LocalDiskArtifactStore(tmp)
            store.put("a/b", b"data", "text/plain", tags={"retention": "scratch"}, filename="b.txt")
            self.assertEqual(store.get("a/b"), b"data")

    def test_lazy_store_forwards_the_extras(self):
        from graph.tools_runtime import _LazyAttachmentStore

        backing = mock.Mock()
        lazy = _LazyAttachmentStore()
        lazy._store = backing
        lazy.put("k", b"x", "text/plain", tags={"retention": "scratch"}, filename="x.txt")
        backing.put.assert_called_once_with("k", b"x", "text/plain",
                                            tags={"retention": "scratch"}, filename="x.txt")

    def test_tool_contexts_tag_artifacts_pending(self):
        from graph.tools_runtime import make_tool_context

        context = make_tool_context("cust-1")
        self.assertEqual(context.artifact_tags, {"retention": "pending"})


class SaveArtifactTests(unittest.TestCase):
    def test_without_a_source_nothing_extra_is_stored(self):
        store = mock.Mock()
        context = ToolContext(customer_id="c", store=store, key_template="customers/{customer_id}/attachments/{artifact_id}")
        artifact = context.save_artifact(b"img", "image/png", "chart.png")
        self.assertEqual(store.put.call_count, 1)
        self.assertIsNone(artifact.source_key)
        self.assertNotIn("source_key", artifact.to_dict())
        self.assertNotIn("page_count", artifact.to_dict())

    def test_artifact_dict_carries_the_optional_fields(self):
        artifact = Artifact(artifact_id="a", key="k", media_type="application/pdf", filename="r.pdf",
                            size_bytes=3, source_key="k.source.md", page_count=0)
        self.assertEqual(artifact.to_dict()["source_key"], "k.source.md")
        self.assertEqual(artifact.to_dict()["page_count"], 0)


class _SlowGraph:
    """Yields one model token after a pause longer than the keepalive."""

    def __init__(self, pause):
        self.pause = pause

    async def astream_events(self, state, config=None, version=None):
        from langchain_core.messages import AIMessageChunk

        await asyncio.sleep(self.pause)
        yield {"event": "on_chat_model_stream", "metadata": {"langgraph_node": "GEN"},
               "data": {"chunk": AIMessageChunk(content="hello")}}


class _FailingGraph:
    async def astream_events(self, state, config=None, version=None):
        raise RuntimeError("graph exploded")
        yield  # pragma: no cover


class KeepaliveTests(unittest.IsolatedAsyncioTestCase):
    async def _frames(self, graph):
        import streaming

        frames = []
        with mock.patch.object(streaming, "KEEPALIVE_SECONDS", 0.05):
            async for frame in streaming.stream_response(
                {"llm_provider": "openai", "customer_id": "cust-1"}, graph=graph, streaming_nodes={"GEN"},
            ):
                frames.append(frame)
        return frames

    async def test_silence_is_filled_with_keepalives(self):
        frames = await self._frames(_SlowGraph(0.3))
        keepalives = [f for f in frames if f == 'data: {"keepalive": true}\n\n']
        self.assertGreaterEqual(len(keepalives), 2)
        contents = [json.loads(f[6:]) for f in frames if f.startswith("data: {") and "content" in f]
        self.assertEqual(contents, [{"content": "hello"}])
        self.assertEqual(frames[-1], "data: [DONE]\n\n")

    async def test_no_keepalive_when_frames_flow(self):
        frames = await self._frames(_SlowGraph(0))
        self.assertNotIn('data: {"keepalive": true}\n\n', frames)

    async def test_graph_errors_still_end_the_stream(self):
        frames = await self._frames(_FailingGraph())
        self.assertEqual(frames[-1], "data: [DONE]\n\n")
        self.assertTrue(any('"error"' in f for f in frames))


class PdfMetricsTests(unittest.TestCase):
    def test_record_accepts_every_shape_without_raising(self):
        from graph import pdf_metrics

        pdf_metrics.record(None)
        pdf_metrics.record({})
        pdf_metrics.record({"status": "ok", "renderer": "typst", "pages": 3, "pdf_bytes": 1000,
                            "render_seconds": 1.5, "render_cpu_seconds": 1.2, "spawn_cpu_seconds": 0.6,
                            "child_peak_rss_bytes": 1.5e8, "queue_wait_seconds": 0.01,
                            "input_chars": 5000, "warnings": {"missing_glyph": 2, "image": 0}})
        pdf_metrics.record({"status": "rejected", "reason": "table_rows", "renderer": "nonsense"})
        pdf_metrics.record({"status": "weird", "render_seconds": "not a number"})
        pdf_metrics.record_truncated("generate_pdf", "max_tokens")

    def test_renderer_labels(self):
        from graph import pdf_metrics

        self.assertEqual(pdf_metrics._renderer({"renderer": "typst"}), "typst")
        # Typst is the only renderer since plan 5.2: anything else, the
        # removed "x2p_v1" included, is labelled with it.
        for other in ("x2p_v1", "nonsense", None):
            self.assertEqual(pdf_metrics._renderer({"renderer": other}), "typst")
        before = pdf_metrics.RENDER_SECONDS.labels(renderer="typst", status="ok")._sum.get()
        pdf_metrics.record({"status": "ok", "renderer": "x2p_v1", "render_seconds": 2.5})
        self.assertEqual(pdf_metrics.RENDER_SECONDS.labels(renderer="typst", status="ok")._sum.get(), before + 2.5)

    def test_rejections_are_counted_by_reason(self):
        from graph import pdf_metrics

        before = pdf_metrics.REJECTED.labels(reason="chars")._value.get()
        pdf_metrics.record({"status": "rejected", "reason": "chars"})
        self.assertEqual(pdf_metrics.REJECTED.labels(reason="chars")._value.get(), before + 1)


if __name__ == "__main__":
    unittest.main()
