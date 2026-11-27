"""Unit tests for how PDF forms are shared by the vendors of a turn
(graph/pdf_input.py over graph/attachment_cache.py), and for the page budget."""
import asyncio
import base64
import io
import threading
import unittest
from unittest.mock import patch

from PIL import Image

import graph.attachment_cache as attachment_cache
from graph import pdf_input
from graph.image_normalize import limits_for_request


def _pdf(pages: int) -> bytes:
    buf = io.BytesIO()
    images = [Image.new("RGB", (200, 260), (40 * i, 90, 160)) for i in range(pages)]
    images[0].save(buf, "PDF", save_all=True, append_images=images[1:])
    return buf.getvalue()


class SharedFormsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        attachment_cache.CACHE.clear()
        self.addCleanup(attachment_cache.CACHE.clear)

    async def test_the_vendors_of_a_turn_download_and_encode_a_pdf_once(self):
        release = threading.Event()
        fetches = []

        def fetch(s3_key):
            fetches.append(s3_key)
            release.wait(5)
            return b"%PDF-1.7 body"

        with patch.object(pdf_input, "_fetch_pdf_bytes_sync", side_effect=fetch):
            waiting = [asyncio.ensure_future(pdf_input.native_pdf_block(p, "cust/doc", "a.pdf"))
                       for p in ("anthropic", "openai", "gemini")]
            await asyncio.sleep(0.05)
            release.set()
            anthropic, openai, gemini = await asyncio.gather(*waiting)
        self.assertEqual(fetches, ["cust/doc"])
        b64 = base64.b64encode(b"%PDF-1.7 body").decode()
        self.assertEqual(anthropic["source"]["data"], b64)
        self.assertIs(gemini["data"], anthropic["source"]["data"])  # one string
        self.assertEqual(openai["file"]["file_data"], f"data:application/pdf;base64,{b64}")

    async def test_rendered_pages_are_shared_by_requests_with_the_same_budget(self):
        renders = []

        def child(op, data, **kwargs):
            renders.append(kwargs)
            return {"pages": ["data:image/png;base64,P1", "data:image/png;base64,P2"], "total": 2, "rendered": 2}

        with patch.object(pdf_input, "_fetch_pdf_bytes_sync", return_value=b"%PDF"), \
                patch.object(pdf_input, "_run_child", side_effect=child):
            first, second = await asyncio.gather(
                pdf_input.pdf_page_image_blocks("cust/doc", "xai", other_images=3),
                pdf_input.pdf_page_image_blocks("cust/doc", "xai", other_images=3),
            )
        self.assertEqual(len(renders), 1)
        self.assertEqual((renders[0]["provider"], renders[0]["other_images"]), ("xai", 3))
        self.assertEqual(first, second)
        self.assertEqual([b["image_url"]["url"] for b in first], ["data:image/png;base64,P1", "data:image/png;base64,P2"])

    async def test_extracted_text_is_prepared_once(self):
        child = {"text": "hello", "truncated": False, "pages": 1}
        with patch.object(pdf_input, "_fetch_pdf_bytes_sync", return_value=b"%PDF"), \
                patch.object(pdf_input, "_run_child", return_value=child) as run_child:
            texts = await asyncio.gather(*(pdf_input.pdf_extracted_text("cust/doc", "a.pdf") for _ in range(3)))
        run_child.assert_called_once()
        self.assertTrue(all(t == texts[0] and "hello" in t for t in texts))


class PageBudgetTests(unittest.TestCase):
    def test_each_page_gets_a_share_of_the_request_budget_with_the_other_images(self):
        seen = []

        def limits(provider, count):
            seen.append((provider, count))
            return limits_for_request(provider, count)

        with patch.object(pdf_input, "limits_for_request", side_effect=limits):
            result = pdf_input._render_pages(_pdf(3), max_pages=30, scale=0.5, provider="xai", other_images=2)
        self.assertEqual(seen, [("xai", 5)])
        self.assertEqual((result["total"], result["rendered"]), (3, 3))
        self.assertTrue(all(u.startswith("data:image/") for u in result["pages"]))

    def test_pages_past_the_render_cap_are_not_counted(self):
        seen = []
        with patch.object(pdf_input, "limits_for_request",
                          side_effect=lambda p, n: seen.append(n) or limits_for_request(p, n)):
            result = pdf_input._render_pages(_pdf(4), max_pages=2, scale=0.5, provider="openai", other_images=0)
        self.assertEqual(seen, [2])
        self.assertEqual((result["total"], result["rendered"]), (4, 2))


if __name__ == "__main__":
    unittest.main()
