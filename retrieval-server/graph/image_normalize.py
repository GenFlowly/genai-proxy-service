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
applies Anthropic's 2000 px rule (to every provider) to requests with more
than 20 images. Beyond what a request can carry (max_images_for_request), the
oldest history images are left out (graph/nodes/llm_node.py).

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
Camera RAW (DNG, CR2/CR3, NEF, ARW, RAF, ...) is first rendered to RGB by
graph/raw_decode.py — LibRaw, in an isolated, resource-capped child process —
and then takes step 2/3 like any other converted image.

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
import json
import logging
import math
import os
import struct
import subprocess
import sys
import threading
import time
from dataclasses import dataclass

import pi_heif
from PIL import Image, ImageOps, JpegImagePlugin, UnidentifiedImageError

logger = logging.getLogger(__name__)

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
MAX_DECODE_BYTES = _env_int("IMAGE_MAX_DECODE_BYTES", 370_000_000)

# libjpeg-turbo's memory cap per (de)compress object, in its decimal "M". A
# JPEG whose scans don't each cover every component (progressive, or
# sequential with non-interleaved scans) needs a full-size coefficient buffer
# whatever draft() scale is asked for; this turns a huge one into a decode
# error instead of an OOM. libjpeg reads it whenever a decoder/encoder is
# created, so setting it at import (before any JPEG work) is enough. Matched
# to the decode budget, so it never refuses what the header guard admitted
# (a 48 MP 4:4:4 progressive JPEG needs ~290 MB); our own encodes need a few MB.
os.environ.setdefault("JPEGMEM", f"{max(64, MAX_DECODE_BYTES // 1_000_000)}M")

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
# inputs: PNG 5.2, WebP 15.4 (libwebp decodes through its animation decoder),
# JPEG 2000 18.5 (OpenJPEG), drafted JPEG 5.6-7.2 — plus a margin. Alpha and
# >8-bit samples roughly double it (measured x1.9). HEIF and AVIF depend on
# bit depth and chroma subsampling: see _HEIF_COST / _AVIF_COST.
_BYTES_PER_PIXEL = {
    "JPEG": 7.5, "PNG": 6.0, "TIFF": 6.0, "BMP": 6.0, "DIB": 6.0, "TGA": 6.0,
    "PPM": 6.0, "QOI": 6.0, "GIF": 6.0, "PSD": 6.0, "AVIF": 13.5, "HEIF": 15.2,
    "WEBP": 17.0, "JPEG2000": 20.0,
}
# (high bit depth, chroma) -> bytes per pixel, from 48.8 MP HEIC / 37.6 MP
# AVIF measurements (HEIC 8-bit 4:2:0 6.9, 10-bit 4:2:0 7.4, 8-bit 4:4:4
# 8.8, 10-bit 4:2:2 12.9 — what pro cameras write — 10-bit 4:4:4 14.5; AVIF
# 8-bit 4:2:0 8.7, 10-bit 4:2:0 / 8-bit 4:4:4 10.1, 10/12-bit 4:4:4 13.1).
# Unknown layouts are charged the worst case (_BYTES_PER_PIXEL).
_HEIF_COST = {
    (False, 420): 7.2, (False, 422): 8.5, (False, 444): 9.3,
    (True, 420): 7.5, (True, 422): 13.5, (True, 444): 15.2,
}
_AVIF_COST = {
    (False, 420): 9.0, (False, 422): 9.8, (False, 444): 10.5,
    (True, 420): 10.5, (True, 422): 12.5, (True, 444): 13.5,
}
# Formats opened at all (Pillow format ids): what phones, cameras' JPEG/HEIF
# output, screenshot tools, browsers and common editor exports produce.
# Multi-frame JPEGs (MPO) open through "JPEG"; PSD opens its merged composite
# (layers load lazily). Tried in this order: AVIF before HEIF, because pi-heif
# also claims AVIF files with a generic "mif1" brand but has no AV1 decoder.
# Pillow registers ~30 more — ICO/ICNS decode inside open() before any guard
# can run, FITS/BLP decode in pure-Python loops, EPS shells out to
# Ghostscript — and in a process shared by every user those are refused with
# an "export it as PNG or JPEG" message.
_OPEN_FORMATS = list(_BYTES_PER_PIXEL)

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
# Applied to every provider: Claude is also reachable through routers
# (OpenRouter, LiteLLM ids), and no vendor looks at more than ~2000 px anyway.
_MANY_IMAGES = 20
_MANY_IMAGES_EDGE = 2000
# Groq: 33,177,600 px per image (= 5760 x 5760).
_MAX_EDGE_BY_PROVIDER = {"groq": 5760}
# Documented per-request image-count limits.
_MAX_IMAGES_BY_PROVIDER = {"anthropic": 100, "groq": 5}
# Camera RAW (DNG, CR2/CR3, NEF, ARW, RAF, ORF, RW2, PEF, X3F, ... — what
# LibRaw reads) is rendered by graph/raw_decode.py in an isolated child
# process (see _decode_camera_raw). Declared types that mark an upload as RAW:
_RAW_MEDIA_TYPES = frozenset({
    "image/dng", "image/x-adobe-dng", "image/x-canon-cr2", "image/x-canon-cr3",
    "image/x-canon-crw", "image/x-nikon-nef", "image/x-nikon-nrw", "image/x-sony-arw",
    "image/x-sony-srf", "image/x-sony-sr2", "image/x-panasonic-rw2", "image/x-panasonic-raw",
    "image/x-olympus-orf", "image/x-fuji-raf", "image/x-pentax-pef", "image/x-samsung-srw",
    "image/x-sigma-x3f", "image/x-hasselblad-3fr", "image/x-phaseone-iiq", "image/x-raw",
})
_RAW_DECODER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "raw_decode.py")
# "preview" (default): the camera's own embedded rendering when it is large
# enough, else a LibRaw demosaic; "demosaic": always render the sensor data.
RAW_RENDER = os.environ.get("IMAGE_RAW_RENDER", "preview").strip().lower()
_RAW_TIMEOUT_S = _env_int("IMAGE_RAW_TIMEOUT_S", 90)
_RAW_CPU_SECONDS = _env_int("IMAGE_RAW_CPU_SECONDS", 60)
# The child's address-space cap on top of the decode budget: ~120 MB is the
# interpreter + numpy + rawpy + Pillow before any work.
_RAW_ADDRESS_SPACE_OVERHEAD = 512 * 1024 * 1024
# Long edge the child hands back: enough to downscale from with margin (our
# output is ~2000 px at most), small enough to keep the pipe and decode cheap.
_RAW_OUTPUT_EDGE = 3200

# Serializes decode/encode: one heavy image job at a time per process.
# Re-entrant: a TIFF that fails to decode falls back to the RAW path, which
# encodes under the same lock.
_HEAVY_LOCK = threading.RLock()


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
    if count > _MANY_IMAGES:
        max_edge = min(max_edge, _MANY_IMAGES_EDGE)
    return ImageLimits(passthrough_formats_for(name), budget, max_edge)


def max_images_for_request(provider: str | None) -> int:
    """How many images one request to `provider` may carry: the vendor's
    documented count limit, and no more than fit its request budget at the
    smallest per-image tier. Older history images beyond it are left out."""
    name = (provider or "").lower()
    smallest_tier = min(min(_BUDGET_TIERS), MAX_BASE64_BYTES)
    by_budget = _REQUEST_IMAGE_BUDGET.get(name, _DEFAULT_REQUEST_IMAGE_BUDGET) // smallest_tier
    return max(1, min(by_budget, _MAX_IMAGES_BY_PROVIDER.get(name, by_budget)))


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

    def camera_raw(raw_kind: str | None) -> NormalizedImage:
        return _normalize_camera_raw(
            data, declared, raw_kind, budget=budget, max_edge=max_edge,
            max_decode_bytes=max_decode_bytes, started=started,
        )

    try:
        im = _open(data, declared)
    except UnsupportedImageError as unsupported:
        # Most camera RAW formats (CR3, RAF, ORF, RW2, X3F, ...) aren't
        # anything Pillow knows; LibRaw gets a go at whatever isn't
        # recognizably something else.
        if not _may_be_camera_raw(data):
            raise
        try:
            return camera_raw(_raw_kind(data, declared))
        except _NotCameraRaw:
            raise unsupported from None
    fmt = "JPEG" if im.format == "MPO" else (im.format or "UNKNOWN")
    source_size = im.size
    if fmt == "TIFF":
        raw_kind = _raw_tiff_kind(im, data)
        if raw_kind:
            # TIFF-structured RAWs (DNG, CR2, NEF, ARW, ...) would otherwise
            # "open" as the small thumbnail in their first IFD.
            try:
                return camera_raw(raw_kind)
            except _NotCameraRaw:
                raise _raw_unreadable(raw_kind, declared) from None
        if declared in _RAW_MEDIA_TYPES:
            try:
                return camera_raw(None)
            except _NotCameraRaw:
                pass  # declared RAW, but LibRaw disagrees: a plain TIFF after all
    pixels = im.size[0] * im.size[1]

    if (_can_pass_through(im, fmt, len(data), passthrough_formats, budget, max_edge)
            and _passthrough_is_intact(data, im, fmt)):
        return NormalizedImage(
            data=data, media_type=_MEDIA_TYPES[fmt], strategy="passthrough",
            source_format=fmt, source_bytes=len(data), source_size=source_size,
            output_size=source_size, elapsed_ms=(time.perf_counter() - started) * 1000,
        )

    # Header-level guards, before anything is allocated for pixels.
    is_jpeg = fmt == "JPEG"
    jp2_reduce = 0
    progressive = False
    if is_jpeg:
        jpeg_limit = max(_JPEG_MAX_HEADER_PIXELS, int(max_decode_bytes / _BYTES_PER_PIXEL["JPEG"]))
        if pixels > jpeg_limit:
            raise ImageTooLargeError(_pixels_message(im.size, jpeg_limit, fmt))
        # Progressive and multi-scan JPEGs buffer every DCT coefficient
        # regardless of draft scale.
        progressive = _jpeg_buffers_coefficients(im, data)
        if progressive:
            progressive_limit = int(max_decode_bytes / _progressive_jpeg_bytes_per_pixel(im))
            if pixels > progressive_limit:
                raise ImageTooLargeError(_pixels_message(im.size, progressive_limit, "progressive/multi-scan JPEG"))
    else:
        if fmt == "JPEG2000":
            jp2_reduce = _jp2_reduce_factor(im.size, max_edge)
        decoded = _scaled_size(im.size, jp2_reduce)
        _check_decode_cost(im, fmt, decoded, source_size, max_decode_bytes, data)

    wait_started = time.perf_counter()
    with _HEAVY_LOCK:
        lock_wait_ms = (time.perf_counter() - wait_started) * 1000
        if is_jpeg:
            _jpeg_draft(im, max_edge)
            _check_decode_cost(im, fmt, im.size, source_size, max_decode_bytes, data)
        try:
            if jp2_reduce:
                im = _load_jpeg2000(data, im, jp2_reduce, source_size, max_decode_bytes)
            else:
                im.load()
        except ImageNormalizationError:
            raise
        except MemoryError:
            raise ImageTooLargeError(_pixels_message(source_size, 0, fmt)) from None
        except Exception as e:  # truncated / corrupt / unsupported codec inside a known container
            if is_jpeg and progressive and pixels > _JPEG_SUSPECT_COEFFICIENT_PIXELS:
                # Most likely libjpeg's JPEGMEM cap on the coefficient buffer,
                # which surfaces as the same "broken data stream" error as
                # corruption. (Single-scan baseline JPEGs never allocate it.)
                raise ImageTooLargeError(_pixels_message(source_size, 0, fmt)) from e
            if fmt == "TIFF":
                # A TIFF Pillow can't decode is often a camera RAW whose first
                # IFD uses a vendor compression (PEF, some NEF/ARW variants).
                try:
                    return camera_raw(None)
                except _NotCameraRaw:
                    pass  # not RAW either: a corrupt TIFF
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
        hint = " This camera RAW file couldn't be read — export it as JPEG, PNG or HEIC."
    elif kind == "video":
        hint = " Videos aren't supported as image attachments."
    else:
        hint = " Export it as PNG or JPEG and try again."
    detected = f"detected: {kind}" if kind else "format not recognized"
    return UnsupportedImageError(
        f"The attached file isn't a supported image ({_join(detected, _declared(declared), sep='; ')}).{hint}"
    )


# Recognizable formats that are deliberately not opened (see _OPEN_FORMATS).
_KNOWN_UNSUPPORTED_MAGIC = (
    (b"\x00\x00\x01\x00", "ICO icon"),
    (b"\x00\x00\x02\x00", "CUR cursor"),
    (b"icns", "ICNS icon"),
    (b"DDS ", "DDS texture"),
    (b"SIMPLE  =", "FITS"),
    (b"BLP1", "BLP texture"),
    (b"BLP2", "BLP texture"),
    (b"%!PS", "PostScript/EPS"),
    (b"\xc5\xd0\xd3\xc6", "PostScript/EPS"),
    (b"gimp xcf", "GIMP XCF"),
    (b"\xff\x0a", "JPEG XL"),
    (b"\x00\x00\x00\x0cJXL ", "JPEG XL"),
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
    for magic, label in _KNOWN_UNSUPPORTED_MAGIC:
        if head.startswith(magic):
            return label
    if head[:4] in (b"IIRO", b"IIU\x00"):
        return "camera RAW"
    if head.startswith(b"\xff\xd8\xff"):
        return "JPEG"
    if head.startswith(b"\x89PNG"):
        return "PNG"
    return None


class _NotCameraRaw(Exception):
    """LibRaw doesn't recognize the bytes as a camera RAW file."""


# Magic numbers of RAW formats Pillow can't open (TIFF-based RAWs are found
# from their TIFF tags instead, see _raw_tiff_kind).
_RAW_MAGIC = (
    (b"FUJIFILMCCD-RAW", "camera RAW (RAF)"),
    (b"IIRO", "camera RAW (ORF)"),
    (b"IIRS", "camera RAW (ORF)"),
    (b"MMOR", "camera RAW (ORF)"),
    (b"IIU\x00", "camera RAW (RW2)"),
    (b"FOVb", "camera RAW (X3F)"),
    (b"\x00MRM", "camera RAW (MRW)"),
)


def _raw_kind(data: bytes, declared: str) -> str | None:
    """A label when the bytes or the declaration say camera RAW, else None."""
    if data[4:12] == b"ftypcrx ":
        return "camera RAW (CR3)"
    for magic, label in _RAW_MAGIC:
        if data.startswith(magic):
            return label
    return "camera RAW" if declared in _RAW_MEDIA_TYPES else None


def _may_be_camera_raw(data: bytes) -> bool:
    """Worth handing to LibRaw: not recognizably some other kind of file."""
    kind = _sniff_label(data)
    return kind is None or "RAW" in kind


def _raw_tiff_kind(im: Image.Image, data: bytes) -> str | None:
    """TIFF-structured RAWs (DNG, CR2, NEF, ARW, ...) by their tags."""
    tags = getattr(im, "tag_v2", {})
    if 50706 in tags:  # DNGVersion
        return "camera RAW (DNG)"
    if data[8:10] == b"CR":  # Canon CR2
        return "camera RAW (CR2)"
    if tags.get(254) == 1 and 330 in tags:
        # IFD0 is a reduced-resolution preview; the real image is in SubIFDs
        return "camera RAW"
    return None


def _raw_unreadable(raw_kind: str | None, declared: str) -> UnsupportedImageError:
    return UnsupportedImageError(
        f"The attached {raw_kind or 'camera RAW'} file couldn't be read{_paren(_declared(declared))}. "
        "Export it as JPEG, PNG or HEIC and try again."
    )


def _normalize_camera_raw(data: bytes, declared: str, raw_kind: str | None, *, budget: int,
                          max_edge: int, max_decode_bytes: int, started: float) -> NormalizedImage:
    """Render a camera RAW (in the isolated child) and encode it like any
    other converted image. Raises _NotCameraRaw when LibRaw doesn't recognize
    the bytes and nothing else marked them as RAW (raw_kind is None)."""
    wait_started = time.perf_counter()
    with _HEAVY_LOCK:
        lock_wait_ms = (time.perf_counter() - wait_started) * 1000
        rendered, header = _decode_camera_raw(data, declared, raw_kind, max_decode_bytes, max_edge)
        _check_decode_cost(rendered, "PNG", rendered.size, rendered.size, max_decode_bytes)
        try:
            out, out_size, strategy = _encode_within_budget(_normalize_mode(rendered), budget, max_edge)
        except MemoryError:
            raise ImageTooLargeError(_pixels_message(rendered.size, 0, "camera RAW")) from None
        del rendered
    sensor = header.get("sensor") or [0, 0]
    return NormalizedImage(
        data=out, media_type="image/jpeg" if strategy == "lossy" else "image/png",
        strategy=strategy, source_format=f"RAW ({header.get('source', '?')})",
        source_bytes=len(data), source_size=(int(sensor[0]), int(sensor[1])), output_size=out_size,
        elapsed_ms=(time.perf_counter() - started) * 1000, lock_wait_ms=lock_wait_ms,
    )


def _decode_camera_raw(data: bytes, declared: str, raw_kind: str | None,
                       max_decode_bytes: int, max_edge: int) -> tuple[Image.Image, dict]:
    """Run graph/raw_decode.py on the bytes in a child process (LibRaw never
    runs in the server process: see that module) and return the upright RGB
    image it renders plus its header."""
    params = {
        "max_decode_bytes": max_decode_bytes,
        "max_address_space": max_decode_bytes + _RAW_ADDRESS_SPACE_OVERHEAD,
        "max_cpu_seconds": _RAW_CPU_SECONDS,
        "min_edge": _FLOOR_EDGE_PX,
        "max_edge": min(max_edge, _RAW_OUTPUT_EDGE),
        "prefer": "demosaic" if RAW_RENDER == "demosaic" else "preview",
    }
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "OMP_NUM_THREADS": "1",  # LibRaw's OpenMP: one shared CPU
        "OPENBLAS_NUM_THREADS": "1",
        "JPEGMEM": os.environ.get("JPEGMEM", ""),
    }
    try:
        proc = subprocess.run(
            [sys.executable, "-I", _RAW_DECODER, json.dumps(params)],
            input=data, capture_output=True, timeout=_RAW_TIMEOUT_S, env=env, check=False,
        )
    except subprocess.TimeoutExpired:
        logger.warning("Camera RAW decode timed out after %ss", _RAW_TIMEOUT_S)
        raise ImageTooLargeError(
            "The attached camera RAW file took too long to process. Export it as JPEG and try again."
        ) from None
    except OSError as e:
        logger.error("Camera RAW decoder could not be started: %s", e)
        raise _raw_unreadable(raw_kind, declared) from e

    if proc.returncode == 0:
        try:
            (header_len,) = struct.unpack(">I", proc.stdout[:4])
            header = json.loads(proc.stdout[4:4 + header_len])
            width, height = int(header["width"]), int(header["height"])
            pixels = proc.stdout[4 + header_len:]
            if not (0 < width <= _RAW_OUTPUT_EDGE and 0 < height <= _RAW_OUTPUT_EDGE) \
                    or len(pixels) != width * height * 3:
                raise ValueError(f"bad image geometry {width}x{height} / {len(pixels)} bytes")
            return Image.frombytes("RGB", (width, height), pixels), header
        except (struct.error, ValueError, KeyError, TypeError) as e:
            logger.error("Camera RAW decoder returned malformed output: %s", e)
            raise _raw_unreadable(raw_kind, declared) from e

    stderr = proc.stderr.decode("utf-8", "replace").strip()
    failure = {}
    if proc.returncode == 2 and stderr:
        try:
            failure = json.loads(stderr.splitlines()[-1])
        except ValueError:
            failure = {}
    kind = failure.get("error")
    if kind == "too_large" or proc.returncode in (-9, -24):  # SIGKILL (OOM), SIGXCPU (CPU cap)
        logger.warning("Camera RAW too large to process (rc=%s): %s", proc.returncode, failure.get("detail", ""))
        raise ImageTooLargeError(
            "The attached camera RAW file is too large to process. Export it as JPEG and try again."
        )
    if kind == "unsupported" and raw_kind is None:
        raise _NotCameraRaw()
    logger.warning("Camera RAW not readable (rc=%s): %s", proc.returncode, (failure.get("detail") or stderr)[-300:])
    raise _raw_unreadable(raw_kind, declared)


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


def _passthrough_is_intact(data: bytes, im: Image.Image, fmt: str) -> bool:
    """Passthrough is decided from the header, so a corrupt or truncated file
    would go to the vendor as-is — and, replayed with the history, fail every
    later turn. Cheap integrity checks: PNG chunk CRCs through IEND (no
    inflate), JPEG entropy data decoded at 1/8 scale, GIF trailer present.
    A file that fails them is not refused here: it takes the conversion path,
    whose full decode is more lenient (a bad ancillary-chunk CRC or a missing
    IEND still converts) and reports real truncation readably."""
    try:
        if fmt == "PNG":
            Image.open(io.BytesIO(data), formats=["PNG"]).verify()
        elif fmt == "JPEG":
            w, h = im.size
            if w * h > _VERIFY_PROGRESSIVE_MAX_PIXELS and _jpeg_buffers_coefficients(im, data):
                return True
            check = Image.open(io.BytesIO(data), formats=["JPEG"])
            check.draft(check.mode if check.mode in ("L", "RGB") else None, (max(1, w // 8), max(1, h // 8)))
            check.load()
        elif fmt == "GIF":
            return data.rstrip(b"\x00")[-1:] == b"\x3b"  # GIF trailer
    except Exception:
        return False
    return True


def _decode_cost_per_pixel(im: Image.Image, fmt: str, data: bytes = b"") -> float:
    """Estimated peak bytes per decoded pixel (see _BYTES_PER_PIXEL). Resampling
    an image that has (or gains) an alpha channel makes a full-size
    premultiplied copy first, and >8-bit samples are converted through 32-bit
    intermediates: each roughly doubles the cost."""
    cost = _BYTES_PER_PIXEL.get(fmt, max(_BYTES_PER_PIXEL.values()))
    if fmt == "HEIF":
        depth, chroma = im.info.get("bit_depth"), im.info.get("chroma")
        if isinstance(depth, int) and chroma in (400, 420, 422, 444):
            cost = _HEIF_COST[(depth > 8, 420 if chroma == 400 else chroma)]
    elif fmt == "AVIF":
        layout = _av1c_layout(data)
        if layout:
            cost = _AVIF_COST[layout]
    if im.mode in ("RGBA", "LA", "PA") or "transparency" in im.info:
        cost *= 2
    if im.mode.startswith("I") or im.mode == "F" or im.mode in ("RGB;16", "RGBA;16"):
        cost *= 2
    return cost


def _av1c_layout(data: bytes) -> tuple[bool, int] | None:
    """(high bit depth, chroma 420/422/444) from an AVIF's av1C box (ISOBMFF
    metadata near the start of the file), or None when not found."""
    i = data.find(b"av1C", 0, 65536)
    if i < 0 or len(data) < i + 7 or data[i + 4] != 0x81:
        return None
    flags = data[i + 6]  # tier | high_bitdepth | twelve_bit | mono | sub_x | sub_y | pos(2)
    high = bool(flags & 0x40)
    sub_x, sub_y, mono = bool(flags & 0x08), bool(flags & 0x04), bool(flags & 0x10)
    chroma = 420 if (mono or (sub_x and sub_y)) else (422 if sub_x else 444)
    return high, chroma


# Start-of-frame markers (C4 DHT, C8 JPG and CC DAC share the range).
_JPEG_SOF_MARKERS = frozenset(range(0xC0, 0xD0)) - {0xC4, 0xC8, 0xCC}


def _jpeg_buffers_coefficients(im: Image.Image, data: bytes) -> bool:
    """Whether libjpeg must keep every DCT coefficient of the whole image (a
    full-size buffer whatever the draft scale): progressive and other
    non-baseline frames, and sequential frames whose first scan doesn't cover
    every component (non-interleaved scans). Walks the marker segments up to
    the first SOS — header bytes only."""
    if im.info.get("progressive") or im.info.get("progression"):
        return True
    i, n, components = 2, len(data), None
    for _ in range(4096):
        if i + 4 > n or data[i] != 0xFF:
            return False
        marker = data[i + 1]
        if marker == 0xFF:  # fill byte
            i += 1
            continue
        if marker == 0x01 or 0xD0 <= marker <= 0xD8:  # standalone markers
            i += 2
            continue
        if marker in _JPEG_SOF_MARKERS:
            if marker not in (0xC0, 0xC1):  # progressive, lossless, arithmetic, hierarchical
                return True
            components = data[i + 9] if i + 9 < n else None
        elif marker == 0xDA:  # SOS: how many components the first scan codes
            return components is not None and i + 4 < n and data[i + 4] < components
        i += 2 + int.from_bytes(data[i + 2:i + 4], "big")
    return False


def _progressive_jpeg_bytes_per_pixel(im: Image.Image) -> float:
    """Progressive / multi-scan JPEGs keep every DCT coefficient regardless of draft scale:
    2 bytes per sample, i.e. 3 B/px at 4:2:0, 4 at 4:2:2, 6 at 4:4:4 — plus
    ~1 B/px for the (drafted) output."""
    layers = getattr(im, "layer", None) or []
    try:
        h_max = max(layer[1] for layer in layers)
        v_max = max(layer[2] for layer in layers)
        samples = sum(layer[1] * layer[2] for layer in layers) / (h_max * v_max)
    except (ValueError, TypeError, IndexError, ZeroDivisionError):
        samples = 3.0  # unknown: assume 4:4:4
    return 2.0 * samples + 1.0


def _check_decode_cost(im: Image.Image, fmt: str, decoded: tuple[int, int],
                       source_size: tuple[int, int], max_decode_bytes: int, data: bytes = b"") -> None:
    per_pixel = _decode_cost_per_pixel(im, fmt, data)
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


def _load_jpeg2000(data: bytes, im: Image.Image, reduce: int,
                   source_size: tuple[int, int], max_decode_bytes: int) -> Image.Image:
    """Decode at 1/2^reduce. A codestream with fewer resolution levels than
    that can't be reduced so far (OpenJPEG errors out), so step the reduction
    down — as long as the larger decode still fits the budget."""
    while True:
        try:
            im.reduce = reduce
            im.load()
            return im
        except MemoryError:
            raise
        except Exception:
            if reduce == 0:
                raise
            reduce -= 1
            im = Image.open(io.BytesIO(data), formats=["JPEG2000"])
            _check_decode_cost(im, "JPEG2000", _scaled_size(im.size, reduce), source_size, max_decode_bytes)


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
    """16-bit / 32-bit int / float greyscale -> 8-bit L (Pillow's plain
    convert clips everything above 255 to white). Integers are mapped by the
    smallest standard sample depth that holds their maximum — 8, 10, 12, 14
    or 16 bits: camera, microscopy and medical data usually sit in a 16-bit
    container with 10-14 significant bits, and mapping those by the 16-bit
    range would hand the model a black image. Floats are nominally 0..1."""
    if im.mode == "F":
        hi = im.getextrema()[1]
        scale = 255.0 if hi <= 1.0 else 255.0 / hi
        return im.point(lambda v: v * scale).convert("L")  # convert clips to 0..255
    if im.mode != "I":
        im = im.convert("I")
    hi = im.getextrema()[1]
    full_scale = next((2**bits - 1 for bits in (8, 10, 12, 14, 16) if hi < 2**bits), hi)
    divisor = full_scale / 255.0
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
