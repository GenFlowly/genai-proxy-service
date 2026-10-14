"""Normalizes user-uploaded images into something every LLM vendor accepts.

Uploads are unrestricted (any type, any size — the proxy no longer filters), so
the bytes in S3 can be HEIC from an iPhone, AVIF, TIFF, a 48 MP PNG, a CMYK
JPEG... while vendors accept only a few formats under hard limits. This module
is the single place that bridges the two. It is pure (bytes in, bytes out — no
S3, no logging of pixel data); graph/s3_images.py wires it to attachments.

Vendor limits this is built around (vendor docs, checked 2026-10):
- Anthropic: JPEG/PNG/GIF/WebP; per image 5 MB *of base64* on Bedrock/Vertex
  (10 MB direct API); max 8000x8000 px (2000 px when >20 images in one
  request); 32 MB per request. Visual detail tops out at a 1568 px long edge
  (2576 px on the high-resolution tier) — larger images are downscaled.
- OpenAI: PNG/JPEG/WebP/non-animated GIF; 50 MB per request.
- Gemini: PNG/JPEG/WebP/HEIC/HEIF (GIF not listed); ~20 MB inline per request.
- xAI: JPEG/PNG only. Groq: 4 MB per base64 request.
JPEG and PNG are the only formats every vendor in the BYOK catalog accepts.

Limits are per request, not just per image: every image in a request
(current turn, replayed history, tool results) shares the vendor's request
size limit, so limits_for_request() gives each one a tiered share of it and
applies Anthropic's 2000 px rule for requests with more than 20 images.

Policy (never trusts the declared media type — the format is sniffed from the
bytes; the declaration is only a hint for messages/logs):
1. Passthrough, bytes untouched, when the sniffed format is one the target
   vendor accepts (passthrough_formats_for), the base64 size is within budget,
   both edges are <= the max edge, there is no EXIF rotation and it is not
   animated. Decided from the header plus a cheap integrity check (PNG chunk
   CRCs, JPEG decoded at 1/8 scale) — never a full pixel decode.
2. Otherwise decode the first frame, apply EXIF orientation, normalize the
   mode (8-bit L/RGB/RGBA, ICC profile kept when the colour space is
   unchanged) and encode losslessly as PNG (universally accepted).
3. If lossless output exceeds the budget, downscale (LANCZOS) and re-encode
   losslessly. The first target size comes from a sampled size estimate, so a
   typical photo needs a single full encode. Downscaling stops at the size
   Claude's standard tier works at (1568 px long edge / ~1.15 MP); below that
   a model would see less, not just fewer bytes.
4. Only if lossless still cannot fit at that floor: JPEG at a 1568 px long
   edge, quality 90 stepping down, then smaller (last resort; alpha is
   flattened onto white). In practice this happens when many images share
   one request.

Resource safety (the retrieval server is one process on 1 GB RAM / one shared
CPU serving everyone): only common image formats are opened at all; the
memory a decode will need (pixels x a measured per-format cost) is checked
from the header before any decode; huge JPEGs decode at 1/2–1/8 scale via
draft() and JPEG 2000 via reduce; heavy decode/encode work is serialized by a
module-level lock (graph/s3_images.py also runs fetch + normalize on one
dedicated worker thread); large intermediates are dropped as soon as they are
replaced.
"""
from __future__ import annotations

import io
import math
import os
import threading
import time
from dataclasses import dataclass

# libjpeg-turbo's memory cap per (de)compress object. A JPEG whose scans don't
# each cover every component (progressive, or sequential with non-interleaved
# scans) needs a full-size coefficient buffer whatever draft() scale is asked
# for; this turns a huge one into a decode error instead of an OOM. Read by
# libjpeg when each decoder/encoder is created, so setting it here (before any
# JPEG work) is enough. Process-wide and generous: a 48 MP 4:2:0 progressive
# photo needs ~150 MB; our own encodes need a few MB.
os.environ.setdefault("JPEGMEM", "256M")

import pi_heif  # noqa: E402
from PIL import Image, ImageOps, JpegImagePlugin, UnidentifiedImageError  # noqa: E402

# HEIF/HEIC decoding (decode-only build of pillow-heif: BSD + LGPL libheif/
# libde265, no GPL x265 encoder). Thumbnails/depth/aux images are never needed.
pi_heif.register_heif_opener(thumbnails=False, depth_images=False, aux_images=False)


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    try:
        return int(raw) if raw else default
    except ValueError:
        return default


# Per-image budget measured on the BASE64 string (Anthropic's 5 MB limit on
# Bedrock/Vertex is checked on the base64 data, = 3.75 MiB of raw bytes). The
# strictest per-image limit among the vendors we route to.
MAX_BASE64_BYTES = _env_int("IMAGE_MAX_BASE64_BYTES", 5 * 1024 * 1024)
# Anthropic rejects images with an edge above 8000 px.
MAX_EDGE_PX = _env_int("IMAGE_MAX_EDGE_PX", 8000)
# Operational OOM guard on the source object — NOT a product size limit. The
# bytes stay resident while they are decoded, so this bounds the worst case at
# ~100 MiB source + decoded pixels (capped below). 100 MiB covers every real
# camera/phone output: 200 MP JPEGs are ~25-60 MB, a 48 MP PNG ~75 MB, an
# uncompressed 8-bit 30 MP TIFF ~90 MB. Checked from S3 ContentLength before
# the body is read.
MAX_SOURCE_BYTES = _env_int("IMAGE_MAX_SOURCE_BYTES", 100 * 1024 * 1024)
# Decompression-bomb / OOM guard: peak memory one decode -> resize -> encode
# may take, estimated before decoding as decoded pixels x _BYTES_PER_PIXEL of
# the format (x2 with alpha or >8-bit samples). 360 MB admits a 48 MP iPhone
# HEIC (8064x6048 = 48.8 MP x 7.2 = 351 MB) and 50 MP PNG/TIFF; WebP and
# JPEG 2000 decode at 2-3x the cost per pixel, so their pixel limits are lower.
# Larger JPEGs (Samsung 108/200 MP) still work: they decode at 1/2–1/8 scale
# via draft(). Sized for a ~200-350 MB server baseline on the 1 GB VM.
MAX_DECODE_BYTES = _env_int("IMAGE_MAX_DECODE_BYTES", 360_000_000)

# Header ceiling for baseline JPEGs decoded through draft(): Samsung 200 MP is
# 16320x12240 = 199.7 MP. Huffman decoding still walks every coefficient, so a
# ceiling keeps CPU time bounded (~1 s at 200 MP on one core).
_JPEG_MAX_HEADER_PIXELS = 256_000_000
# draft() target: decode big JPEGs at the smallest 1/2^n scale whose long edge
# is still >= this. Photo content never fits the lossless budget above a
# ~2300 px long edge, and no vendor uses more than 3072 px, so 3200 keeps
# >1.35x oversampling for the final LANCZOS step (and lets a 7900 px 48 MP
# JPEG decode at 1/2).
_JPEG_DRAFT_MIN_EDGE = 3200
# A JPEG this large that fails to decode most likely hit the JPEGMEM cap
# (multi-scan coefficient buffer) rather than being corrupt.
_JPEG_SUSPECT_COEFFICIENT_PIXELS = 40_000_000
# Passthrough JPEGs are integrity-checked by a 1/8-scale decode; progressive
# ones still buffer every coefficient, so only below this size.
_VERIFY_PROGRESSIVE_MAX_PIXELS = 24_000_000
# Size Claude's standard tier works at: it downscales anything with a longer
# edge than 1568 px or more than ~1.15 MP. The lossless loop stops there (the
# floor); the lossy last resort starts at the long edge.
_FLOOR_EDGE_PX = 1568
_FLOOR_PIXELS = 1_200_000
# The lossy last resort shrinks below the floor only when even JPEG q50 at
# the floor does not fit (many images sharing one request); never below this.
_MIN_LOSSY_EDGE_PX = 512
# zlib level for PNG output. Measured on one core (12 MP photo-like, 3 MP
# crop): level 1 = 305 ms / 3.69 MB, level 3 = 461 ms / 3.49 MB, level 6 =
# 1373 ms / 3.19 MB. Level 3 buys ~6% more pixels per budget than level 1 for
# ~150 ms; level 6 tripled encode time for another ~9%.
_PNG_COMPRESS_LEVEL = 3
# Lossy last resort (JPEG — the only lossy format every vendor accepts).
_LOSSY_QUALITIES = (90, 80, 70, 60, 50)
# Margin on every sqrt(budget/size) rescale so the next encode lands under
# budget (~90% of it by area) instead of just over it — an overshoot costs a
# whole extra encode.
_SCALE_SAFETY = 0.95
_MAX_LOSSLESS_ATTEMPTS = 4

# Peak RSS growth per decoded pixel for the whole decode -> resize -> encode
# pipeline (8-bit, no alpha), measured on one core with 48 MP photo-like
# inputs: PNG 5.2, HEIC 6.9, AVIF 8.6, WebP 15.4 (libwebp decodes through its
# animation decoder), JPEG 2000 18.5 (OpenJPEG), drafted JPEG 5.6-7.2 — plus
# a margin. Alpha and >8-bit samples roughly double it (measured x1.9).
_BYTES_PER_PIXEL = {
    "JPEG": 7.5, "PNG": 6.0, "TIFF": 6.0, "BMP": 6.0, "DIB": 6.0, "TGA": 6.0,
    "PPM": 6.0, "QOI": 6.0, "GIF": 6.0, "AVIF": 9.5, "HEIF": 7.2, "WEBP": 17.0,
    "JPEG2000": 20.0,
}
# Formats opened at all (Pillow format ids): what phones, cameras' JPEG/HEIF
# output, screenshot tools, browsers and common editor exports produce.
# Multi-frame JPEGs (MPO) open through "JPEG". Tried in this order: AVIF
# before HEIF, because pi-heif also claims AVIF files with a generic "mif1"
# brand but has no AV1 decoder. Pillow registers ~30 more —
# ICO/ICNS decode inside open() before any guard can run, FITS/BLP decode in
# pure-Python loops, EPS shells out to Ghostscript — and in a process shared
# by every user those are refused with the usual "isn't a supported image".
_OPEN_FORMATS = list(_BYTES_PER_PIXEL)
# Progressive JPEGs keep every DCT coefficient (2 bytes x 1.5 samples per
# pixel at 4:2:0) regardless of draft scale.
_PROGRESSIVE_JPEG_BYTES_PER_PIXEL = 3.0

# Formats each vendor documents as accepted (see module docstring). Anything
# else — including unknown/LiteLLM-routed vendors — gets the universal set.
_UNIVERSAL_FORMATS = frozenset({"JPEG", "PNG"})
_VENDOR_FORMATS = {
    "anthropic": frozenset({"JPEG", "PNG", "GIF", "WEBP"}),
    "openai": frozenset({"JPEG", "PNG", "GIF", "WEBP"}),  # non-animated GIF only
    "gemini": frozenset({"JPEG", "PNG", "WEBP"}),  # GIF is not a documented input
}
_MEDIA_TYPES = {"JPEG": "image/jpeg", "PNG": "image/png", "GIF": "image/gif", "WEBP": "image/webp"}

_MiB = 1024 * 1024
# Base64 bytes all images of one request may take together, per vendor —
# below each documented request limit, leaving room for text, history and
# tools: Anthropic 32 MB per request, OpenAI 50 MB, Gemini ~20 MB inline,
# Groq 4 MB with base64 images. Unknown/LiteLLM-routed vendors: Gemini-like.
_REQUEST_IMAGE_BUDGET = {
    "anthropic": 24 * _MiB,
    "openai": 40 * _MiB,
    "gemini": 15 * _MiB,
    "groq": 3 * _MiB,
}
_DEFAULT_REQUEST_IMAGE_BUDGET = 15 * _MiB
# Per-image budgets are rounded down to one of these tiers, so the share (and
# the cache key built from it) only changes at a few image counts as a
# conversation grows, not on every turn.
_BUDGET_TIERS = (5 * _MiB, 4 * _MiB, 3 * _MiB, 5 * _MiB // 2, 2 * _MiB, 3 * _MiB // 2,
                 _MiB, 3 * _MiB // 4, _MiB // 2)
# Anthropic rejects every image over 2000 px in a request with > 20 images.
_ANTHROPIC_MANY_IMAGES = 20
_ANTHROPIC_MANY_IMAGES_EDGE = 2000
# Groq: 33,177,600 px per image (= 5760 x 5760).
_MAX_EDGE_BY_PROVIDER = {"groq": 5760}
# Camera RAW is out of scope (needs a demosaicing pipeline). TIFF-based RAWs
# (DNG, CR2, NEF, ARW...) would otherwise "open" as their embedded thumbnail.
_RAW_MEDIA_TYPES = frozenset({
    "image/dng", "image/x-adobe-dng", "image/x-canon-cr2", "image/x-canon-cr3",
    "image/x-nikon-nef", "image/x-sony-arw", "image/x-panasonic-rw2",
    "image/x-olympus-orf", "image/x-fuji-raf", "image/x-pentax-pef",
    "image/x-samsung-srw", "image/x-raw",
})

# Serializes decode/encode: one heavy image job at a time per process.
_HEAVY_LOCK = threading.Lock()


class ImageNormalizationError(ValueError):
    """An attached image could not be prepared for the model. str(e) is a
    complete, user-readable sentence — it is shown to the user as-is."""


class UnsupportedImageError(ImageNormalizationError):
    """The bytes are not a raster image we can decode (SVG, PDF, RAW, garbage,
    truncated...)."""


class ImageTooLargeError(ImageNormalizationError):
    """The image exceeds an operational memory guard (source bytes / pixels)."""


@dataclass(frozen=True)
class ImageLimits:
    """What one image may take in a request to a given vendor. Hashable: it is
    part of the normalized-image cache key."""
    passthrough_formats: frozenset[str]
    max_base64_bytes: int
    max_edge: int


@dataclass(frozen=True)
class NormalizedImage:
    data: bytes
    media_type: str
    # passthrough | lossless | lossless_downscaled | lossy
    strategy: str
    source_format: str
    source_bytes: int
    source_size: tuple[int, int]
    output_size: tuple[int, int]
    elapsed_ms: float = 0.0
    lock_wait_ms: float = 0.0

    def log_summary(self) -> str:
        """One log-safe line — dimensions and sizes only, never pixel data."""
        sw, sh = self.source_size
        ow, oh = self.output_size
        return (
            f"{self.source_format} {self.source_bytes} B {sw}x{sh} -> {self.media_type} "
            f"{len(self.data)} B {ow}x{oh} strategy={self.strategy} "
            f"ms={self.elapsed_ms:.0f} lock_wait_ms={self.lock_wait_ms:.0f}"
        )


def passthrough_formats_for(provider: str | None) -> frozenset[str]:
    """Image formats the given LLM provider accepts as-is."""
    return _VENDOR_FORMATS.get((provider or "").lower(), _UNIVERSAL_FORMATS)


def limits_for_request(provider: str | None, image_count: int) -> ImageLimits:
    """Per-image limits when `image_count` images go to `provider` in one
    request: an even, tiered share of the vendor's request budget (capped at
    the per-image MAX_BASE64_BYTES), and the vendor's edge limit."""
    name = (provider or "").lower()
    count = max(1, image_count)
    share = _REQUEST_IMAGE_BUDGET.get(name, _DEFAULT_REQUEST_IMAGE_BUDGET) // count
    tiers = [t for t in _BUDGET_TIERS if t <= MAX_BASE64_BYTES] or [MAX_BASE64_BYTES]
    # Below the smallest tier the request may exceed the vendor's limit anyway
    # (dozens of images); the smallest tier still keeps each one legible.
    budget = next((t for t in tiers if t <= share), tiers[-1])
    max_edge = min(MAX_EDGE_PX, _MAX_EDGE_BY_PROVIDER.get(name, MAX_EDGE_PX))
    if name == "anthropic" and count > _ANTHROPIC_MANY_IMAGES:
        max_edge = min(max_edge, _ANTHROPIC_MANY_IMAGES_EDGE)
    return ImageLimits(passthrough_formats_for(name), budget, max_edge)


def base64_len(n: int) -> int:
    return 4 * ((n + 2) // 3)


def normalize_image(
    data: bytes,
    declared_media_type: str | None = None,
    *,
    passthrough_formats: frozenset[str] = _UNIVERSAL_FORMATS,
    max_base64_bytes: int | None = None,
    max_edge: int | None = None,
    max_source_bytes: int | None = None,
    max_decode_bytes: int | None = None,
) -> NormalizedImage:
    """Return image bytes + media type that every targeted vendor accepts.

    Raises UnsupportedImageError for non-images / undecodable input and
    ImageTooLargeError when an operational memory guard trips. Limits default
    to the module settings (env-configurable); pass them to override.
    """
    started = time.perf_counter()
    budget_b64 = MAX_BASE64_BYTES if max_base64_bytes is None else max_base64_bytes
    max_edge = MAX_EDGE_PX if max_edge is None else max_edge
    max_source_bytes = MAX_SOURCE_BYTES if max_source_bytes is None else max_source_bytes
    max_decode_bytes = MAX_DECODE_BYTES if max_decode_bytes is None else max_decode_bytes
    # Largest raw byte count whose base64 encoding fits the budget.
    budget = (budget_b64 // 4) * 3
    declared = _clean_media_type(declared_media_type)

    if not data:
        raise UnsupportedImageError(f"The attached file is empty{_paren(_declared(declared))}.")
    if len(data) > max_source_bytes:
        raise ImageTooLargeError(source_too_large_message(len(data), max_source_bytes))

    im = _open(data, declared)
    fmt = "JPEG" if im.format == "MPO" else (im.format or "UNKNOWN")
    source_size = im.size
    _reject_camera_raw(im, data, declared)
    pixels = im.size[0] * im.size[1]

    if _can_pass_through(im, fmt, len(data), passthrough_formats, budget, max_edge):
        _verify_passthrough(data, im, fmt, declared)
        return NormalizedImage(
            data=data, media_type=_MEDIA_TYPES[fmt], strategy="passthrough",
            source_format=fmt, source_bytes=len(data), source_size=source_size,
            output_size=source_size, elapsed_ms=(time.perf_counter() - started) * 1000,
        )

    # Header-level guards, before anything is allocated for pixels.
    is_jpeg = fmt == "JPEG"
    jp2_reduce = 0
    if is_jpeg:
        jpeg_limit = max(_JPEG_MAX_HEADER_PIXELS, int(max_decode_bytes / _BYTES_PER_PIXEL["JPEG"]))
        if pixels > jpeg_limit:
            raise ImageTooLargeError(_pixels_message(im.size, jpeg_limit, fmt))
        # Progressive JPEGs buffer every DCT coefficient regardless of draft scale.
        progressive_limit = int(max_decode_bytes / _PROGRESSIVE_JPEG_BYTES_PER_PIXEL)
        if pixels > progressive_limit and (im.info.get("progressive") or im.info.get("progression")):
            raise ImageTooLargeError(_pixels_message(im.size, progressive_limit, "progressive JPEG"))
    else:
        if fmt == "JPEG2000":
            jp2_reduce = _jp2_reduce_factor(im.size, max_edge)
        decoded = _scaled_size(im.size, jp2_reduce)
        _check_decode_cost(im, fmt, decoded, source_size, max_decode_bytes)

    wait_started = time.perf_counter()
    with _HEAVY_LOCK:
        lock_wait_ms = (time.perf_counter() - wait_started) * 1000
        if is_jpeg:
            _jpeg_draft(im, max_edge)
            _check_decode_cost(im, fmt, im.size, source_size, max_decode_bytes)
        elif jp2_reduce and hasattr(im, "_reduce"):
            im._reduce = jp2_reduce  # OpenJPEG decodes at 1/2^n resolution (Pillow's reduce)
        try:
            im.load()
        except MemoryError:
            raise ImageTooLargeError(_pixels_message(source_size, 0, fmt)) from None
        except Exception as e:  # truncated / corrupt / unsupported codec inside a known container
            if is_jpeg and pixels > _JPEG_SUSPECT_COEFFICIENT_PIXELS:
                # Most likely libjpeg's JPEGMEM cap on a multi-scan JPEG, which
                # surfaces as the same "broken data stream" error as corruption.
                raise ImageTooLargeError(_pixels_message(source_size, 0, fmt)) from e
            raise UnsupportedImageError(
                f"The attached image could not be decoded{_paren(_join(fmt, _declared(declared)))}: "
                "the file appears to be corrupt or truncated."
            ) from e
        if fmt == "WEBP":
            # libwebp's animation decoder keeps ~10 B/px of buffers alive until
            # the file is closed: keep only the decoded frame.
            frame = im.copy()
            im.close()
            im = frame
        try:
            if _orientation(im) not in (None, 1):
                ImageOps.exif_transpose(im, in_place=True)
            im = _normalize_mode(im)
            out, out_size, strategy = _encode_within_budget(im, budget, max_edge)
        except ImageNormalizationError:
            raise
        except MemoryError:
            raise ImageTooLargeError(_pixels_message(source_size, 0, fmt)) from None
        except Exception as e:  # e.g. a colour mode Pillow cannot convert
            raise UnsupportedImageError(
                f"The attached image uses a colour format that couldn't be converted ({fmt}, {im.mode}). "
                "Export it as PNG or JPEG and try again."
            ) from e
        del im

    return NormalizedImage(
        data=out, media_type="image/jpeg" if strategy == "lossy" else "image/png",
        strategy=strategy, source_format=fmt, source_bytes=len(data), source_size=source_size,
        output_size=out_size, elapsed_ms=(time.perf_counter() - started) * 1000,
        lock_wait_ms=lock_wait_ms,
    )


def source_too_large_message(size: int, limit: int) -> str:
    return (
        f"The attached image is too large to process ({size / 2**20:.0f} MB; "
        f"the limit is {limit / 2**20:.0f} MB). Please export a smaller version and try again."
    )


# --- sniffing / guards -------------------------------------------------------

def _open(data: bytes, declared: str) -> Image.Image:
    """Image.open (header parse only — no pixel decode for the allowed
    formats) with readable errors."""
    try:
        return Image.open(io.BytesIO(data), formats=_OPEN_FORMATS)
    except Image.DecompressionBombError:
        # Pillow's own guard (> ~179 MP) fires before our draft() path can
        # shrink a huge JPEG; reopen baseline JPEGs directly and apply our own
        # limits. Anything else that large is refused.
        if data[:3] == b"\xff\xd8\xff":
            try:
                return JpegImagePlugin.JpegImageFile(io.BytesIO(data))
            except Exception as e:
                raise _unsupported(data, declared) from e
        raise ImageTooLargeError(
            "The attached image is too large to process (more than "
            f"{2 * Image.MAX_IMAGE_PIXELS / 1e6:.0f} megapixels). Please export a smaller version."
        ) from None
    except MemoryError:
        raise ImageTooLargeError(
            "The attached image is too large to process. Please export a smaller version."
        ) from None
    except Exception as e:  # any plugin failure on untrusted bytes: not a supported image
        raise _unsupported(data, declared) from e


def _unsupported(data: bytes, declared: str) -> UnsupportedImageError:
    kind = _sniff_label(data)
    if kind in ("SVG", "PDF"):
        hint = " Vector graphics and PDFs aren't supported as image attachments — export it as PNG or JPEG."
    elif kind and "RAW" in kind:
        hint = " Camera RAW files aren't supported — export it as JPEG, PNG or HEIC."
    elif kind == "video":
        hint = " Videos aren't supported as image attachments."
    else:
        hint = ""
    detected = f"detected: {kind}" if kind else "format not recognized"
    return UnsupportedImageError(
        f"The attached file isn't a supported image ({_join(detected, _declared(declared), sep='; ')}).{hint}"
    )


def _sniff_label(data: bytes) -> str | None:
    """Best-effort label for files Pillow cannot decode — for messages only."""
    head = data[:512]
    stripped = head.lstrip(b"\xef\xbb\xbf \t\r\n")
    if stripped.startswith(b"%PDF"):
        return "PDF"
    if stripped.startswith(b"<svg") or (stripped.startswith(b"<?xml") and b"<svg" in head):
        return "SVG"
    if head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand in (b"crx ",):
            return "camera RAW (CR3)"
        if brand in (b"qt  ", b"isom", b"mp41", b"mp42", b"M4V ", b"3gp4", b"3gp5", b"avc1"):
            return "video"
        return f"ISO-BMFF ({brand.decode('latin-1').strip()})"
    if head.startswith(b"FUJIFILMCCD-RAW"):
        return "camera RAW (RAF)"
    if head[:4] in (b"IIRO", b"IIU\x00"):
        return "camera RAW"
    if head.startswith(b"\xff\xd8\xff"):
        return "JPEG"
    if head.startswith(b"\x89PNG"):
        return "PNG"
    return None


def _reject_camera_raw(im: Image.Image, data: bytes, declared: str) -> None:
    """TIFF-structured RAWs (DNG, CR2, NEF, ARW...) open as TIFF and would be
    sent as their embedded thumbnail; other RAWs don't open at all. The
    declared type only counts for TIFF bytes — a real JPEG is a JPEG."""
    if im.format != "TIFF":
        return
    tags = getattr(im, "tag_v2", {})
    is_raw = (
        declared in _RAW_MEDIA_TYPES
        or 50706 in tags  # DNGVersion
        or data[8:10] == b"CR"  # Canon CR2
        # IFD0 is a reduced-resolution preview, the real image lives in SubIFDs
        or (tags.get(254) == 1 and 330 in tags)
    )
    if is_raw:
        raise UnsupportedImageError(
            f"The attached file is a camera RAW image{_paren(_declared(declared))}, "
            "which isn't supported. Export it as JPEG, PNG or HEIC and try again."
        )


def _can_pass_through(im, fmt, nbytes, passthrough_formats, budget, max_edge) -> bool:
    if fmt not in passthrough_formats or fmt not in _MEDIA_TYPES:
        return False
    if nbytes > budget or max(im.size) > max_edge:
        return False
    # Vendors want stills (OpenAI rejects animated GIF). Multi-frame JPEGs (MPO:
    # Ultra HDR gain maps, stereo pairs) are plain JPEGs to every decoder.
    if fmt != "JPEG":
        try:
            animated = getattr(im, "is_animated", False)
        except Exception:  # e.g. a truncated GIF: let the full decode report it
            return False
        if animated:
            return False
    if fmt == "JPEG" and im.mode not in ("L", "RGB"):  # CMYK/YCCK render wrongly in many decoders
        return False
    return _orientation(im) in (None, 1)


def _orientation(im: Image.Image) -> int | None:
    """EXIF orientation from metadata parsed at open — never triggers a decode
    (PNG's getexif() would load the whole image to look for a late eXIf chunk)."""
    raw = im.info.get("exif")
    if not raw:
        return None
    try:
        exif = Image.Exif()
        exif.load(raw)
        return exif.get(0x0112)
    except Exception:
        return None


def _verify_passthrough(data: bytes, im: Image.Image, fmt: str, declared: str) -> None:
    """Passthrough is decided from the header, so a corrupt or truncated file
    would go to the vendor as-is — and, replayed with the history, fail every
    later turn. Cheap integrity checks: PNG chunk CRCs through IEND (no
    inflate), JPEG entropy data decoded at 1/8 scale. GIF/WebP: header only."""
    try:
        if fmt == "PNG":
            Image.open(io.BytesIO(data), formats=["PNG"]).verify()
        elif fmt == "JPEG":
            w, h = im.size
            progressive = im.info.get("progressive") or im.info.get("progression")
            if progressive and w * h > _VERIFY_PROGRESSIVE_MAX_PIXELS:
                return
            check = Image.open(io.BytesIO(data), formats=["JPEG"])
            check.draft(check.mode if check.mode in ("L", "RGB") else None, (max(1, w // 8), max(1, h // 8)))
            check.load()
    except MemoryError:
        raise ImageTooLargeError(_pixels_message(im.size, 0, fmt)) from None
    except Exception as e:
        raise UnsupportedImageError(
            f"The attached image could not be decoded{_paren(_join(fmt, _declared(declared)))}: "
            "the file appears to be corrupt or truncated."
        ) from e


def _decode_cost_per_pixel(im: Image.Image, fmt: str) -> float:
    """Estimated peak bytes per decoded pixel (see _BYTES_PER_PIXEL). Resampling
    an image that has (or gains) an alpha channel makes a full-size
    premultiplied copy first, and >8-bit samples are converted through 32-bit
    intermediates: each roughly doubles the cost."""
    cost = _BYTES_PER_PIXEL.get(fmt, max(_BYTES_PER_PIXEL.values()))
    if im.mode in ("RGBA", "LA", "PA") or "transparency" in im.info:
        cost *= 2
    if im.mode.startswith("I") or im.mode == "F" or im.mode in ("RGB;16", "RGBA;16"):
        cost *= 2
    return cost


def _check_decode_cost(im: Image.Image, fmt: str, decoded: tuple[int, int],
                       source_size: tuple[int, int], max_decode_bytes: int) -> None:
    per_pixel = _decode_cost_per_pixel(im, fmt)
    if decoded[0] * decoded[1] * per_pixel > max_decode_bytes:
        has_alpha = im.mode in ("RGBA", "LA", "PA") or "transparency" in im.info
        label = f"{fmt} (with transparency)" if has_alpha else fmt
        raise ImageTooLargeError(_pixels_message(source_size, int(max_decode_bytes / per_pixel), label))


def _jp2_reduce_factor(size: tuple[int, int], max_edge: int) -> int:
    """Resolution levels to skip when decoding JPEG 2000 (OpenJPEG decodes at
    1/2^n directly), keeping the long edge >= min(max_edge, 4000) like JPEG's
    draft()."""
    target = min(max_edge, _JPEG_DRAFT_MIN_EDGE)
    n = 0
    while max(size) >> (n + 1) >= target and n < 5:
        n += 1
    return n


def _scaled_size(size: tuple[int, int], reduce: int) -> tuple[int, int]:
    power = 1 << reduce
    return (-(-size[0] // power), -(-size[1] // power))


def _jpeg_draft(im: Image.Image, max_edge: int) -> None:
    """Ask libjpeg to decode at 1/2, 1/4 or 1/8 scale (DCT-domain, nearly free)
    while keeping the long edge >= min(max_edge, _JPEG_DRAFT_MIN_EDGE)."""
    w, h = im.size
    target = min(max_edge, _JPEG_DRAFT_MIN_EDGE)
    if max(w, h) < 2 * target:
        return
    s = target / max(w, h)
    im.draft(im.mode if im.mode in ("L", "RGB") else None, (max(1, math.ceil(w * s)), max(1, math.ceil(h * s))))


def _pixels_message(size: tuple[int, int], limit: int, fmt: str) -> str:
    w, h = size
    limit_text = f"; the limit for {fmt} images is {limit / 1e6:.0f} megapixels" if limit else ""
    return (
        f"The attached image is too large to process ({w}x{h} = {w * h / 1e6:.0f} megapixels{limit_text}). "
        "Please export a smaller version and try again."
    )


def _clean_media_type(value: str | None) -> str:
    return (value or "").split(";", 1)[0].strip().lower()[:100]


def _declared(declared: str) -> str:
    """'declared image/heic', or '' when the browser declared nothing useful."""
    return f"declared {declared}" if declared and declared != "application/octet-stream" else ""


def _join(*parts: str, sep: str = ", ") -> str:
    return sep.join(p for p in parts if p)


def _paren(text: str) -> str:
    return f" ({text})" if text else ""


# --- pixel work (caller holds _HEAVY_LOCK) ------------------------------------

def _normalize_mode(im: Image.Image) -> Image.Image:
    """8-bit L / RGB / RGBA, colour-managed where the colour space changes.
    Returns the image to encode; metadata other than a matching ICC profile
    (EXIF incl. GPS, text chunks) is dropped — orientation is already applied."""
    mode = im.mode
    icc = im.info.get("icc_profile")
    has_key = "transparency" in im.info  # palette / colour-key transparency
    if mode.startswith("I") or mode == "F":
        out = _high_bit_depth_to_l(im)
    elif mode == "CMYK":
        out = _cmyk_to_rgb(im, icc)
        icc = None  # converted to sRGB; a CMYK profile must never ride along
    elif mode in ("RGB", "L", "RGBA") and not has_key:
        out = im
    elif mode == "1" and not has_key:
        out = im.convert("L")
    elif mode in ("P", "PA", "LA", "RGB", "L", "1"):
        out = im.convert("RGBA")
    else:  # YCbCr, LAB, HSV, RGBX, ...
        out = im.convert("RGBA" if "A" in im.getbands() else "RGB")
        if mode in ("LAB", "HSV"):
            icc = None
    keep_icc = icc and _icc_colour_space(icc) == (b"GRAY" if out.mode == "L" else b"RGB ")
    out.info = {"icc_profile": icc} if keep_icc else {}
    return out


def _icc_colour_space(icc: bytes) -> bytes:
    return icc[16:20]  # ICC header: data colour space signature


def _high_bit_depth_to_l(im: Image.Image) -> Image.Image:
    """16-bit / 32-bit int / float greyscale -> 8-bit L by the format's nominal
    range, so a dark exposure stays dark (Pillow's plain convert clips
    everything above 255 to white): integers as 16-bit (v / 257), floats as
    0..1. Only values beyond that range fall back to scaling by the maximum."""
    if im.mode == "F":
        hi = im.getextrema()[1]
        scale = 255.0 if hi <= 1.0 else 255.0 / hi
        return im.point(lambda v: v * scale).convert("L")  # convert clips to 0..255
    if im.mode != "I":
        im = im.convert("I")
    hi = im.getextrema()[1]
    divisor = 257.0 if hi <= 65535 else hi / 255.0
    return im.point(lambda v: v / divisor).convert("L")  # point() keeps I; convert clips


def _cmyk_to_rgb(im: Image.Image, icc: bytes | None) -> Image.Image:
    if icc:
        try:
            from PIL import ImageCms  # littlecms; only needed for this rare path

            src = ImageCms.ImageCmsProfile(io.BytesIO(icc))
            return ImageCms.profileToProfile(im, src, ImageCms.createProfile("sRGB"), outputMode="RGB")
        except Exception:
            pass  # unusable embedded profile: fall back to the naive transform
    return im.convert("RGB")


def _encode_png(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    kwargs = {"compress_level": _PNG_COMPRESS_LEVEL}
    if im.info.get("icc_profile"):
        kwargs["icc_profile"] = im.info["icc_profile"]
    im.save(buf, "PNG", **kwargs)
    return buf.getvalue()


class _SizeEstimator:
    """Predicts the lossless PNG size of the whole image at a given scale by
    encoding a 6x6 mosaic of evenly spread tiles (~1.3 MP, a fixed cost
    whatever the source size) instead of the full image. Measured at the
    candidate scale itself, because bytes-per-pixel moves with downscaling in
    a content-dependent way (detail densifies; sensor noise averages out)."""

    GRID = 6
    MAX_TILE = 192

    def __init__(self, im: Image.Image, drop_alpha: bool):
        w, h = im.size
        tile = min(self.MAX_TILE, min(w, h) // (2 * self.GRID))
        self.full_pixels = w * h
        self.mosaic = Image.new(im.mode, (tile * self.GRID, tile * self.GRID))
        for gy in range(self.GRID):
            for gx in range(self.GRID):
                x = (w - tile) * gx // (self.GRID - 1)
                y = (h - tile) * gy // (self.GRID - 1)
                self.mosaic.paste(im.crop((x, y, x + tile, y + tile)), (gx * tile, gy * tile))
        if drop_alpha:
            self.mosaic = self.mosaic.convert("RGB")

    @classmethod
    def worthwhile(cls, im: Image.Image) -> bool:
        # Below ~2 MP a real encode is about as cheap as the estimate.
        return im.size[0] * im.size[1] > 2_000_000 and min(im.size) >= 2 * cls.GRID * 32

    def estimate(self, scale: float) -> float:
        sample = _resized(self.mosaic, scale)
        size = len(_encode_png(sample))
        return size * (self.full_pixels * scale * scale) / (sample.size[0] * sample.size[1])


def _resized(im: Image.Image, scale: float) -> Image.Image:
    if scale >= 1.0:
        return im
    w, h = im.size
    size = (max(1, round(w * scale)), max(1, round(h * scale)))
    out = im.resize(size, Image.Resampling.LANCZOS, reducing_gap=3.0)
    out.info = dict(im.info)
    return out


def _encode_within_budget(im: Image.Image, budget: int, max_edge: int) -> tuple[bytes, tuple[int, int], str]:
    w, h = im.size
    long_edge = max(w, h)
    cap = min(1.0, max_edge / long_edge)
    floor = min(cap, _FLOOR_EDGE_PX / long_edge, math.sqrt(_FLOOR_PIXELS / (w * h)))
    # A fully opaque alpha channel carries no information: dropping it shrinks
    # the PNG. Done per candidate, after downscaling, so the full-size image is
    # never copied just to remove it.
    drop_alpha = im.mode == "RGBA" and im.getextrema()[3][0] == 255

    def candidate_at(scale: float) -> Image.Image:
        c = _resized(im, scale)  # always from the full-quality source
        return c.convert("RGB") if drop_alpha else c

    scale = cap
    if _SizeEstimator.worthwhile(im):
        # Pick the first full-encode size from two cheap mosaic estimates: one
        # at the capped size, one re-measured at the resulting guess.
        estimator = _SizeEstimator(im, drop_alpha)
        estimate = estimator.estimate(scale)
        if estimate > budget:
            scale = max(floor, scale * math.sqrt(budget / estimate))
            if scale > floor:
                estimate = estimator.estimate(scale)
                scale = max(floor, min(cap, scale * math.sqrt(budget / estimate) * _SCALE_SAFETY))
        del estimator

    for _ in range(_MAX_LOSSLESS_ATTEMPTS):
        candidate = candidate_at(scale)
        out = _encode_png(candidate)
        if len(out) <= budget:
            return out, candidate.size, ("lossless" if scale >= 1.0 else "lossless_downscaled")
        del candidate
        if scale <= floor:
            break
        scale = max(floor, scale * math.sqrt(budget / len(out)) * _SCALE_SAFETY)

    # Last resort: lossy at Claude's long edge, then smaller while even q50
    # does not fit (only when many images share one request's budget).
    scale = min(cap, _FLOOR_EDGE_PX / long_edge)
    min_scale = min(scale, _MIN_LOSSY_EDGE_PX / long_edge)
    while True:
        candidate = candidate_at(scale)
        if candidate.mode == "RGBA":
            flat = Image.new("RGB", candidate.size, (255, 255, 255))
            flat.paste(candidate, mask=candidate.getchannel("A"))
            flat.info = candidate.info
            candidate = flat
        icc = candidate.info.get("icc_profile")
        for quality in _LOSSY_QUALITIES:
            buf = io.BytesIO()
            candidate.save(buf, "JPEG", quality=quality, **({"icc_profile": icc} if icc else {}))
            if buf.tell() <= budget:
                return buf.getvalue(), candidate.size, "lossy"
        if scale <= min_scale:
            break
        scale = max(min_scale, scale * 0.75)
    raise ImageTooLargeError(
        "The attached image could not be compressed enough for the model. "
        "Please export a smaller version and try again."
    )
