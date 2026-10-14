"""
Unit tests for attachment image normalization (graph/image_normalize.py) and
its wiring (graph/s3_images.py, llm_node image blocks, streaming errors).

Run with `python -m unittest tests.test_image_normalize`.

Uploads are unrestricted, so whatever lands in S3 must leave here as bytes the
target vendor accepts: passthrough when already fine (bytes identical, media
type from the sniffed format — never the declaration), otherwise lossless PNG,
downscaled only to fit the budget, lossy JPEG only as a last resort.
Fixtures are generated in memory; the HEIC one is a committed 1 KB file
(tests/fixtures/iphone_like.heic — 160x120, red left half, blue right half)
because the runtime dependency (pi-heif) is decode-only.
"""
import base64
import io
import os
import struct
import unittest
import zlib
from unittest.mock import MagicMock, patch

from botocore.exceptions import ClientError
from PIL import Image, ImageCms, ImageFile, TiffImagePlugin

import graph.image_normalize as image_normalize
import graph.nodes.llm_node as llm_node_module
import graph.s3_images as s3_images
from graph.image_normalize import (
    ImageNormalizationError,
    ImageTooLargeError,
    UnsupportedImageError,
    normalize_image,
    passthrough_formats_for,
)
from streaming import stream_events_dicts, user_facing_llm_error

_FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")
_ANTHROPIC = passthrough_formats_for("anthropic")
_UNIVERSAL = passthrough_formats_for(None)


def _encode(im: Image.Image, fmt: str, **kw) -> bytes:
    buf = io.BytesIO()
    im.save(buf, fmt, **kw)
    return buf.getvalue()


def _decode(data: bytes) -> Image.Image:
    im = Image.open(io.BytesIO(data))
    im.load()
    return im


def _pixels(im: Image.Image) -> bytes:
    return im.tobytes()


def _photo_like(w: int, h: int, sigma: float = 12.0) -> Image.Image:
    """Gradient + Gaussian noise per channel: compresses like a photo, not a flat fill."""
    grad = Image.linear_gradient("L").resize((w, h))
    channels = [
        Image.blend(grad, Image.effect_noise((w, h), sigma), 0.35),
        Image.blend(grad.transpose(Image.Transpose.FLIP_LEFT_RIGHT), Image.effect_noise((w, h), sigma), 0.35),
        Image.effect_noise((w, h), sigma),
    ]
    return Image.merge("RGB", channels)


def _png_header_only(w: int, h: int) -> bytes:
    """A PNG claiming w x h pixels with a few bytes of pixel data (bomb-shaped)."""
    def chunk(kind: bytes, payload: bytes) -> bytes:
        crc = zlib.crc32(kind + payload) & 0xFFFFFFFF
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", crc)
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"\x00" * 16)) + chunk(b"IEND", b"")


def _heic_bytes() -> bytes:
    with open(os.path.join(_FIXTURES, "iphone_like.heic"), "rb") as f:
        return f.read()


class PassthroughTests(unittest.TestCase):
    def test_vendor_safe_formats_pass_through_byte_identical(self):
        im = Image.new("RGB", (64, 48), (10, 120, 200))
        cases = {
            "PNG": ("image/png", _encode(im, "PNG")),
            "JPEG": ("image/jpeg", _encode(im, "JPEG", quality=90)),
            "WEBP": ("image/webp", _encode(im, "WEBP", quality=80)),
            "GIF": ("image/gif", _encode(im.convert("P"), "GIF")),
        }
        for fmt, (media_type, data) in cases.items():
            with self.subTest(fmt=fmt):
                out = normalize_image(data, media_type, passthrough_formats=_ANTHROPIC)
                self.assertEqual(out.strategy, "passthrough")
                self.assertIs(out.data, data)
                self.assertEqual(out.media_type, media_type)

    def test_media_type_comes_from_the_bytes_not_the_declaration(self):
        jpeg = _encode(Image.new("RGB", (32, 32), "white"), "JPEG")
        for declared in ("application/octet-stream", "", None, "image/png", "image/heic"):
            with self.subTest(declared=declared):
                out = normalize_image(jpeg, declared)
                self.assertEqual(out.media_type, "image/jpeg")
                self.assertEqual(out.strategy, "passthrough")

    def test_formats_a_vendor_does_not_accept_are_converted(self):
        # Gemini documents no GIF; xAI (and unknown vendors) take JPEG/PNG only.
        im = Image.new("RGB", (40, 30), (200, 10, 10))
        gif = _encode(im.convert("P"), "GIF")
        webp = _encode(im, "WEBP", lossless=True)
        out = normalize_image(gif, "image/gif", passthrough_formats=passthrough_formats_for("gemini"))
        self.assertEqual((out.media_type, out.strategy), ("image/png", "lossless"))
        out = normalize_image(webp, "image/webp", passthrough_formats=passthrough_formats_for("xai"))
        self.assertEqual((out.media_type, out.strategy), ("image/png", "lossless"))
        self.assertEqual(_pixels(_decode(out.data).convert("RGB")), _pixels(im))

    def test_vendor_format_table(self):
        self.assertEqual(passthrough_formats_for("anthropic"), {"JPEG", "PNG", "GIF", "WEBP"})
        self.assertEqual(passthrough_formats_for("OpenAI"), {"JPEG", "PNG", "GIF", "WEBP"})
        self.assertEqual(passthrough_formats_for("gemini"), {"JPEG", "PNG", "WEBP"})
        for other in ("xai", "mistral", "bedrock", "", None):
            self.assertEqual(passthrough_formats_for(other), {"JPEG", "PNG"})

    def test_animated_gif_is_flattened_to_its_first_frame(self):
        frames = [Image.new("RGB", (20, 20), c).convert("P") for c in ("red", "green")]
        buf = io.BytesIO()
        frames[0].save(buf, "GIF", save_all=True, append_images=frames[1:], duration=100, loop=0)
        out = normalize_image(buf.getvalue(), "image/gif", passthrough_formats=_ANTHROPIC)
        self.assertEqual(out.media_type, "image/png")
        self.assertEqual(_decode(out.data).convert("RGB").getpixel((5, 5)), (255, 0, 0))

    def test_multi_frame_jpeg_mpo_passes_through_as_jpeg(self):
        # Ultra HDR (gain map) and stereo JPEGs open as MPO with 2+ frames, but
        # they are ordinary JPEGs to every decoder — not animations.
        buf = io.BytesIO()
        Image.new("RGB", (64, 48), "red").save(
            buf, "MPO", save_all=True, append_images=[Image.new("RGB", (32, 24), "blue")]
        )
        out = normalize_image(buf.getvalue(), "image/jpeg")
        self.assertEqual((out.source_format, out.media_type, out.strategy), ("JPEG", "image/jpeg", "passthrough"))

    def test_raw_declaration_does_not_override_real_jpeg_bytes(self):
        jpeg = _encode(Image.new("RGB", (32, 32), "white"), "JPEG")
        out = normalize_image(jpeg, "image/x-nikon-nef")
        self.assertEqual((out.media_type, out.strategy), ("image/jpeg", "passthrough"))

    def test_cmyk_jpeg_is_converted_to_rgb(self):
        data = _encode(Image.new("CMYK", (30, 20), (0, 255, 255, 0)), "JPEG", quality=95)
        out = normalize_image(data, "image/jpeg")
        self.assertEqual(out.media_type, "image/png")
        result = _decode(out.data)
        self.assertEqual(result.mode, "RGB")
        r, g, b = result.getpixel((10, 10))
        self.assertGreater(r, 200)
        self.assertLess(g, 60)


class ConversionTests(unittest.TestCase):
    def test_heic_becomes_lossless_png_with_the_same_pixels(self):
        heic = _heic_bytes()
        out = normalize_image(heic, "application/octet-stream")
        self.assertEqual((out.source_format, out.media_type, out.strategy), ("HEIF", "image/png", "lossless"))
        self.assertEqual(out.output_size, (160, 120))
        result = _decode(out.data)
        self.assertEqual(result.format, "PNG")
        self.assertEqual(_pixels(result.convert("RGB")), _pixels(_decode(heic).convert("RGB")))
        r, _, b = result.getpixel((10, 60))
        self.assertGreater(r, b)  # red half stays on the left (no rotation/mirroring)

    def test_tiff_bmp_and_avif_are_converted(self):
        im = _photo_like(120, 80)
        cases = [("TIFF", "image/tiff", {}), ("BMP", "image/bmp", {})]
        if "AVIF" in Image.SAVE:
            cases.append(("AVIF", "image/avif", {"quality": 90}))
        for fmt, declared, kw in cases:
            with self.subTest(fmt=fmt):
                data = _encode(im, fmt, **kw)
                out = normalize_image(data, declared)
                self.assertEqual((out.source_format, out.media_type, out.strategy), (fmt, "image/png", "lossless"))
                # Lossless: the PNG holds exactly the pixels the source decodes to.
                self.assertEqual(_pixels(_decode(out.data)), _pixels(_decode(data).convert("RGB")))

    def test_exif_rotated_jpeg_is_transposed_upright(self):
        im = Image.new("RGB", (80, 40), (255, 0, 0))
        im.paste((0, 0, 255), (40, 0, 80, 40))  # stored: red left, blue right
        exif = im.getexif()
        exif[0x0112] = 6  # display rotated 90° clockwise
        data = _encode(im, "JPEG", quality=95, exif=exif.tobytes())
        out = normalize_image(data, "image/jpeg")
        self.assertNotEqual(out.strategy, "passthrough")
        self.assertEqual(out.output_size, (40, 80))
        result = _decode(out.data)
        self.assertEqual(result.size, (40, 80))
        self.assertNotIn(0x0112, result.getexif())  # no orientation left to re-apply
        top, bottom = result.getpixel((20, 10)), result.getpixel((20, 70))
        self.assertGreater(top[0], top[2])  # red on top after a clockwise turn
        self.assertGreater(bottom[2], bottom[0])

    def test_alpha_is_preserved_and_opaque_alpha_dropped(self):
        rgba = Image.new("RGBA", (50, 40), (0, 128, 255, 255))
        rgba.paste((255, 0, 0, 0), (0, 0, 25, 40))  # left half fully transparent
        out = normalize_image(_encode(rgba, "TIFF"), "image/tiff")
        result = _decode(out.data)
        self.assertEqual(result.mode, "RGBA")
        self.assertEqual(result.getpixel((5, 5))[3], 0)
        self.assertEqual(result.getpixel((40, 5)), (0, 128, 255, 255))

        opaque = Image.new("RGBA", (50, 40), (0, 128, 255, 255))
        out = normalize_image(_encode(opaque, "TIFF"), "image/tiff")
        self.assertEqual(_decode(out.data).mode, "RGB")

    def test_palette_transparency_becomes_rgba(self):
        p = Image.new("P", (20, 20), 1)
        p.putpalette([0, 0, 0, 255, 0, 0] + [0] * 762)
        p.paste(0, (0, 0, 10, 20))
        data = _encode(p, "GIF", transparency=0)
        out = normalize_image(data, "image/gif", passthrough_formats=_UNIVERSAL)
        result = _decode(out.data)
        self.assertEqual(result.mode, "RGBA")
        self.assertEqual(result.getpixel((2, 2))[3], 0)
        self.assertEqual(result.getpixel((15, 2)), (255, 0, 0, 255))

    def test_16_bit_greyscale_is_scaled_not_clipped(self):
        im = Image.new("I;16", (4, 1))
        im.putdata([0, 16384, 32768, 65535])
        out = normalize_image(_encode(im, "TIFF"), "image/tiff")
        result = _decode(out.data)
        self.assertEqual(result.mode, "L")
        values = [result.getpixel((x, 0)) for x in range(4)]
        self.assertEqual(values[0], 0)
        self.assertEqual(values[3], 255)
        self.assertTrue(60 <= values[1] <= 68 and 124 <= values[2] <= 132, values)

    def test_icc_profile_is_kept_for_rgb(self):
        icc = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
        data = _encode(_photo_like(60, 40), "TIFF", icc_profile=icc)
        out = normalize_image(data, "image/tiff")
        self.assertEqual(_decode(out.data).info.get("icc_profile"), icc)
        # Also when an opaque alpha channel is dropped on the way.
        data = _encode(_photo_like(60, 40).convert("RGBA"), "TIFF", icc_profile=icc)
        result = _decode(normalize_image(data, "image/tiff").data)
        self.assertEqual((result.mode, result.info.get("icc_profile")), ("RGB", icc))

    def test_output_strips_exif_metadata(self):
        im = Image.new("RGB", (40, 40), "white")
        exif = im.getexif()
        exif[0x010F] = "PhoneMaker"  # Make
        out = normalize_image(_encode(im, "TIFF", exif=exif.tobytes()), "image/tiff")
        self.assertEqual(dict(_decode(out.data).getexif()), {})


class BudgetTests(unittest.TestCase):
    def test_oversized_noisy_png_is_downscaled_losslessly_to_fit(self):
        src = _photo_like(2400, 1800)
        data = _encode(src, "PNG", compress_level=1)
        budget = 1024 * 1024  # base64 bytes
        self.assertGreater(image_normalize.base64_len(len(data)), budget)
        with patch.object(image_normalize, "_FLOOR_EDGE_PX", 400):
            out = normalize_image(data, "image/png", max_base64_bytes=budget)
        self.assertEqual((out.media_type, out.strategy), ("image/png", "lossless_downscaled"))
        self.assertLessEqual(image_normalize.base64_len(len(out.data)), budget)
        w, h = out.output_size
        self.assertTrue(400 <= w < 2400, out.output_size)
        self.assertAlmostEqual(w / h, 2400 / 1800, delta=0.01)
        # Not wastefully small: within the budget's upper half.
        self.assertGreater(image_normalize.base64_len(len(out.data)), budget // 2)

    def test_edge_over_max_is_capped(self):
        data = _encode(Image.new("RGB", (3000, 200), (40, 90, 160)), "PNG")
        out = normalize_image(data, "image/png", max_edge=1000)
        self.assertEqual(out.strategy, "lossless_downscaled")
        self.assertEqual(out.output_size, (1000, 67))

    def test_incompressible_input_falls_back_to_lossy_jpeg(self):
        noise = Image.merge("RGB", [Image.effect_noise((300, 200), 128) for _ in range(3)])
        budget = 60_000
        out = normalize_image(_encode(noise, "PNG"), "image/png", max_base64_bytes=budget)
        self.assertEqual((out.media_type, out.strategy), ("image/jpeg", "lossy"))
        self.assertLessEqual(image_normalize.base64_len(len(out.data)), budget)
        self.assertEqual(out.output_size, (300, 200))  # already below the floor: no downscale

    def test_lossy_fallback_flattens_alpha(self):
        noise = Image.merge("RGBA", [Image.effect_noise((200, 150), 128) for _ in range(4)])
        out = normalize_image(_encode(noise, "PNG"), "image/png", max_base64_bytes=40_000)
        self.assertEqual(out.media_type, "image/jpeg")
        self.assertEqual(_decode(out.data).mode, "RGB")


class RejectionTests(unittest.TestCase):
    def test_garbage_svg_pdf_and_empty_raise_unsupported(self):
        cases = {
            "garbage": (os.urandom(4096), None, "format not recognized"),
            "svg": (b'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>', "image/svg+xml", "SVG"),
            "pdf": (b"%PDF-1.7\n1 0 obj<<>>endobj\n", "application/pdf", "PDF"),
            "video": (b"\x00\x00\x00\x18ftypqt  \x00\x00\x00\x00qt  " + b"\x00" * 64, "video/quicktime", "video"),
            "empty": (b"", "image/png", "empty"),
        }
        for name, (data, declared, needle) in cases.items():
            with self.subTest(name=name):
                with self.assertRaises(UnsupportedImageError) as ctx:
                    normalize_image(data, declared)
                self.assertIsInstance(ctx.exception, ValueError)
                self.assertIn(needle, str(ctx.exception))
                if declared and name != "empty":
                    self.assertIn(declared, str(ctx.exception))

    def test_truncated_image_raises_unsupported(self):
        heic = _heic_bytes()
        with self.assertRaises(UnsupportedImageError):
            normalize_image(heic[: len(heic) // 2], "image/heic")
        png = _encode(_photo_like(200, 200), "PNG")
        with self.assertRaises(UnsupportedImageError):
            # Not passthrough-eligible (edge cap), so it must be decoded — and fails.
            normalize_image(png[: len(png) // 2], "image/png", max_edge=100)

    def test_camera_raw_is_rejected_with_a_clear_message(self):
        dng_tags = TiffImagePlugin.ImageFileDirectory_v2()
        dng_tags[50706] = b"\x01\x04\x00\x00"  # DNGVersion
        dng_tags.tagtype[50706] = 1
        dng = _encode(Image.new("RGB", (64, 48)), "TIFF", tiffinfo=dng_tags)
        with self.assertRaises(UnsupportedImageError) as ctx:
            normalize_image(dng, "application/octet-stream")
        self.assertIn("RAW", str(ctx.exception))
        tiff = _encode(Image.new("RGB", (64, 48)), "TIFF")
        with self.assertRaises(UnsupportedImageError):
            normalize_image(tiff, "image/x-nikon-nef")

    def test_decompression_bomb_header_is_refused_before_decoding(self):
        def no_decode(self):
            raise AssertionError("pixel data must not be decoded")

        with patch.object(ImageFile.ImageFile, "load", no_decode):
            # 10 gigapixels: beyond Pillow's own guard.
            with self.assertRaises(ImageTooLargeError):
                normalize_image(_png_header_only(100_000, 100_000), "image/png")
            # 72 MP: under Pillow's guard, over ours.
            with self.assertRaises(ImageTooLargeError) as ctx:
                normalize_image(_png_header_only(9000, 8000), "image/png")
        self.assertIn("9000x8000", str(ctx.exception))

    def test_images_with_alpha_get_half_the_decode_pixel_limit(self):
        rgb = _encode(Image.new("RGB", (1000, 800)), "TIFF")
        rgba = _encode(Image.new("RGBA", (1000, 800)), "TIFF")
        normalize_image(rgb, "image/tiff", max_decode_pixels=1_000_000)
        with self.assertRaises(ImageTooLargeError) as ctx:
            normalize_image(rgba, "image/tiff", max_decode_pixels=1_000_000)
        self.assertIn("transparency", str(ctx.exception))

    def test_source_bytes_ceiling(self):
        data = _encode(Image.new("RGB", (64, 64)), "PNG")
        with self.assertRaises(ImageTooLargeError) as ctx:
            normalize_image(data, "image/png", max_source_bytes=len(data) - 1)
        self.assertIn("too large", str(ctx.exception))


class ConcurrencyTests(unittest.TestCase):
    def test_heavy_work_is_serialized_across_threads(self):
        import threading
        import time

        active, peak, guard = [0], [0], threading.Lock()
        real = image_normalize._normalize_mode

        def tracking(im):
            with guard:
                active[0] += 1
                peak[0] = max(peak[0], active[0])
            time.sleep(0.05)
            try:
                return real(im)
            finally:
                with guard:
                    active[0] -= 1

        data = _encode(_photo_like(64, 48), "TIFF")
        errors = []

        def run():
            try:
                normalize_image(data, "image/tiff")
            except Exception as e:  # pragma: no cover — surfaced below
                errors.append(e)

        with patch.object(image_normalize, "_normalize_mode", tracking):
            threads = [threading.Thread(target=run) for _ in range(4)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
        self.assertEqual(errors, [])
        self.assertEqual(peak[0], 1)


class JpegDraftTests(unittest.TestCase):
    def _jpeg(self, w, h, **kw) -> bytes:
        return _encode(Image.linear_gradient("L").resize((w, h)).convert("RGB"), "JPEG", quality=85, **kw)

    def test_large_jpeg_decodes_at_reduced_scale_under_the_pixel_limit(self):
        data = self._jpeg(2400, 1600)  # 3.84 MP — over a 1 MP decode limit
        out = normalize_image(data, "image/jpeg", max_edge=600, max_decode_pixels=1_000_000)
        self.assertEqual(out.output_size, (600, 400))
        self.assertEqual(out.source_size, (2400, 1600))

    def test_without_draft_room_the_pixel_limit_applies(self):
        # EXIF rotation forces a decode (a plain in-budget JPEG would pass
        # through without one); no 1/2^n scale keeps the 2400 px edge.
        exif = Image.Exif()
        exif[0x0112] = 6
        data = self._jpeg(2400, 1600, exif=exif.tobytes())
        with self.assertRaises(ImageTooLargeError):
            normalize_image(data, "image/jpeg", max_edge=2400, max_decode_pixels=1_000_000)

    def test_in_budget_jpeg_passes_through_without_decoding_regardless_of_pixel_limit(self):
        data = self._jpeg(2400, 1600)
        out = normalize_image(data, "image/jpeg", max_edge=2400, max_decode_pixels=1_000_000)
        self.assertEqual(out.strategy, "passthrough")

    def test_progressive_jpeg_over_the_limit_is_refused(self):
        data = self._jpeg(2400, 1600, progressive=True)
        with self.assertRaises(ImageTooLargeError) as ctx:
            normalize_image(data, "image/jpeg", max_edge=600, max_decode_pixels=1_000_000)
        self.assertIn("progressive", str(ctx.exception))

    def test_jpeg_beyond_pillows_bomb_guard_still_works_via_draft(self):
        # Simulates a 200 MP Samsung JPEG at test scale: Pillow's own guard
        # would refuse it at open; baseline JPEGs are reopened and drafted.
        data = self._jpeg(2400, 1600)
        png = _encode(Image.new("RGB", (2400, 1600)), "PNG")
        with patch.object(Image, "MAX_IMAGE_PIXELS", 500_000):
            out = normalize_image(data, "image/jpeg", max_edge=600, max_decode_pixels=1_000_000)
            self.assertEqual(out.output_size, (600, 400))
            with self.assertRaises(ImageTooLargeError):
                normalize_image(png, "image/png", max_edge=600)


class S3FetchTests(unittest.TestCase):
    def setUp(self):
        s3_images._fetch_normalized.cache_clear()
        self.addCleanup(s3_images._fetch_normalized.cache_clear)
        env = patch.dict(os.environ, {"ATTACHMENTS_BUCKET": "bucket"})
        env.start()
        self.addCleanup(env.stop)

    def _client(self, data: bytes, content_type: str = "application/octet-stream"):
        body = MagicMock()
        body.read.return_value = data
        client = MagicMock()
        client.get_object.return_value = {"Body": body, "ContentLength": len(data), "ContentType": content_type}
        return client, body

    def test_returns_normalized_base64_and_sniffed_media_type_and_caches(self):
        heic = _heic_bytes()
        client, _ = self._client(heic)
        with patch.object(s3_images, "_client", return_value=client):
            b64, media_type = s3_images.fetch_image_for_llm("cust/att-1", "anthropic")
            again = s3_images.fetch_image_for_llm("cust/att-1", "anthropic")
        self.assertEqual(media_type, "image/png")
        self.assertEqual(_decode(base64.b64decode(b64)).size, (160, 120))
        self.assertEqual(again, (b64, media_type))
        client.get_object.assert_called_once_with(Bucket="bucket", Key="cust/att-1")

    def test_source_ceiling_is_checked_before_reading_the_body(self):
        client, body = self._client(b"x" * 10)
        client.get_object.return_value["ContentLength"] = 10 * 2**30
        with patch.object(s3_images, "_client", return_value=client):
            with self.assertRaises(ImageTooLargeError):
                s3_images.fetch_image_for_llm("cust/huge")
        body.read.assert_not_called()
        body.close.assert_called_once()

    def test_storage_errors_become_readable_attachment_errors(self):
        client = MagicMock()
        client.get_object.side_effect = ClientError({"Error": {"Code": "NoSuchKey", "Message": "x"}}, "GetObject")
        with patch.object(s3_images, "_client", return_value=client):
            with self.assertRaises(ImageNormalizationError) as ctx:
                s3_images.fetch_image_for_llm("cust/missing")
        self.assertIn("NoSuchKey", str(ctx.exception))


class _RaisingGraph:
    def __init__(self, exc):
        self._exc = exc

    async def astream_events(self, state, config=None, version=None):
        raise self._exc
        yield  # pragma: no cover — makes this an async generator


class LlmWiringTests(unittest.IsolatedAsyncioTestCase):
    async def test_image_blocks_use_the_normalized_media_type(self):
        fetch = MagicMock(return_value=("QUJD", "image/png"))
        with patch.object(llm_node_module, "fetch_image_for_llm", fetch):
            blocks = await llm_node_module._image_blocks(
                [{"s3_key": "cust/a.heic", "media_type": "image/heic"}], strict=True, provider="anthropic",
            )
        self.assertEqual(blocks, [{"type": "image_url", "image_url": {"url": "data:image/png;base64,QUJD"}}])
        fetch.assert_called_once_with("cust/a.heic", "anthropic")

    async def test_strict_failure_raises_and_history_degrades(self):
        fetch = MagicMock(side_effect=UnsupportedImageError("The attached file isn't a supported image (detected: SVG)."))
        images = [{"s3_key": "cust/a.svg", "media_type": "image/svg+xml"}]
        with patch.object(llm_node_module, "fetch_image_for_llm", fetch):
            with self.assertRaises(UnsupportedImageError):
                await llm_node_module._image_blocks(images, strict=True, provider="openai")
            blocks = await llm_node_module._image_blocks(images, strict=False, provider="openai")
        self.assertEqual(blocks, [{"type": "text", "text": "[attached image unavailable]"}])

    async def test_tool_result_s3_images_use_the_normalized_media_type(self):
        fetch = MagicMock(return_value=("QUJD", "image/png"))
        results = [{"tool_call_id": "t1", "content": "shot", "images": [{"s3_key": "cust/s.tiff", "media_type": "image/tiff"}]}]
        with patch.object(llm_node_module, "fetch_image_for_llm", fetch):
            [msg] = await llm_node_module._tool_messages(results, "anthropic")
        self.assertIn({"type": "image_url", "image_url": {"url": "data:image/png;base64,QUJD"}}, msg.content)

    async def test_attachment_errors_reach_the_stream_verbatim(self):
        message = "The attached image is too large to process (9000x8000 = 72 megapixels; the limit for PNG images is 52 megapixels)."
        self.assertEqual(user_facing_llm_error(ImageTooLargeError(message), "anthropic"), ("attachment_error", message))
        payloads = [
            p async for p in stream_events_dicts(
                {"llm_provider": "anthropic", "customer_id": "cust-1"},
                graph=_RaisingGraph(UnsupportedImageError("The attached file isn't a supported image (detected: SVG).")),
                streaming_nodes=set(),
            )
        ]
        self.assertEqual(payloads[-1], {
            "error": "The attached file isn't a supported image (detected: SVG).",
            "error_type": "attachment_error",
        })


if __name__ == "__main__":
    unittest.main()
