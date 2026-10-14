"""Fetches attachment images from S3, normalized for multimodal LLM calls.

The proxy server only sends S3 keys (never bytes) — this module resolves them
at LLM-call time. Uploads are unrestricted (any type, any size), so every
object goes through graph/image_normalize.py, which sniffs the real format and
returns bytes + media type the target vendor accepts within the request's
per-image limits (passthrough when already fine, otherwise lossless
conversion/downscale). The original S3 object is never modified.

Fetch + normalize run on ONE dedicated worker thread: only one source object
is resident and decoding at a time (the server is one process on 1 GB RAM
serving everyone), and requests queued behind a slow conversion don't occupy
asyncio's shared default executor. Results — and permanent failures — are
kept in a byte-bounded LRU so a continuing conversation doesn't refetch and
reconvert the same images on every turn.
"""
import asyncio
import base64
import logging
import os
import threading
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from graph import image_normalize
from graph.image_normalize import ImageLimits, ImageNormalizationError, ImageTooLargeError

logger = logging.getLogger(__name__)

_s3_client = None

_IMAGE_POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="attachment-image")


class AttachmentFetchError(ImageNormalizationError):
    """The attachment object could not be read from S3 (user-readable).
    Transient by nature, so never cached."""


class _ByteBoundedLRU:
    """LRU keyed by (s3_key, ImageLimits) holding (base64, media_type) results
    or remembered permanent failures, bounded by total base64 size rather than
    entry count: replaying a long thread's history walks its images in order
    every turn, which an entry-count LRU smaller than the thread misses on
    every lookup. S3 keys are immutable (fresh UUID per upload), so entries
    never go stale."""

    def __init__(self, max_bytes: int):
        self._max_bytes = max_bytes
        self._entries: OrderedDict = OrderedDict()
        self._bytes = 0
        self._lock = threading.Lock()

    def get(self, key):
        with self._lock:
            entry = self._entries.get(key)
            if entry is not None:
                self._entries.move_to_end(key)
            return entry

    def put(self, key, value, cost: int) -> None:
        if cost > self._max_bytes:
            return
        with self._lock:
            old = self._entries.pop(key, None)
            if old is not None:
                self._bytes -= old[1]
            self._entries[key] = (value, cost)
            self._bytes += cost
            while self._bytes > self._max_bytes:
                _, (_, evicted_cost) = self._entries.popitem(last=False)
                self._bytes -= evicted_cost

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._bytes = 0


# 64 MiB of base64 holds a dozen full-budget images or ~40 at the tiers long
# threads get; sized against the 1 GB VM next to one in-flight conversion.
_CACHE = _ByteBoundedLRU(image_normalize._env_int("IMAGE_CACHE_BYTES", 64 * 1024 * 1024))


def _client():
    global _s3_client
    if _s3_client is None:
        _s3_client = boto3.client("s3")
    return _s3_client


def _from_cache(key):
    entry = _CACHE.get(key)
    if entry is None:
        return None
    value = entry[0]
    if isinstance(value, tuple) and len(value) == 2 and isinstance(value[0], type):
        error_type, message = value
        raise error_type(message)  # a fresh instance: re-raising one would grow its traceback
    return value


async def image_for_llm(s3_key: str, limits: ImageLimits) -> tuple[str, str]:
    """(base64, media_type) of an attachment, ready for a data-URL image block.

    Cache hits return immediately; misses queue on the dedicated image worker.
    Raises ImageNormalizationError (user-readable) when the file can't be used,
    RuntimeError on missing bucket configuration.
    """
    cached = _from_cache((s3_key, limits))
    if cached is not None:
        return cached
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_IMAGE_POOL, fetch_image_for_llm, s3_key, limits)


def fetch_image_for_llm(s3_key: str, limits: ImageLimits) -> tuple[str, str]:
    """Synchronous core of image_for_llm (runs on the image worker). The media
    type is that of the bytes actually returned (sniffed/converted), never the
    uploader's declaration."""
    key = (s3_key, limits)
    cached = _from_cache(key)
    if cached is not None:
        return cached
    try:
        result = _fetch_normalized(s3_key, limits)
    except AttachmentFetchError:
        raise
    except ImageNormalizationError as e:
        # Unsupported / too large is a property of the (immutable) object and
        # the limits: remember it instead of re-downloading it every turn.
        _CACHE.put(key, (type(e), str(e)), cost=len(str(e)) + 256)
        raise
    _CACHE.put(key, result, cost=len(result[0]))
    return result


def _fetch_normalized(s3_key: str, limits: ImageLimits) -> tuple[str, str]:
    bucket = os.environ.get("ATTACHMENTS_BUCKET", "")
    if not bucket:
        raise RuntimeError("ATTACHMENTS_BUCKET environment variable is not set")
    try:
        obj = _client().get_object(Bucket=bucket, Key=s3_key)
        # Operational OOM guard, checked before the body is read into memory.
        size = obj.get("ContentLength")
        limit = image_normalize.MAX_SOURCE_BYTES
        if size is not None and size > limit:
            obj["Body"].close()
            raise ImageTooLargeError(image_normalize.source_too_large_message(size, limit))
        data = obj["Body"].read()
    except (ClientError, BotoCoreError) as e:
        code = getattr(e, "response", {}).get("Error", {}).get("Code") or type(e).__name__
        logger.warning("Attachment %s could not be read from S3: %s", s3_key, code)
        if code in ("NoSuchKey", "404", "NotFound"):
            message = "An attached image is no longer available. Please attach it again."
        else:
            message = "An attached image could not be loaded right now. Please try again."
        raise AttachmentFetchError(message) from e

    result = image_normalize.normalize_image(
        data, obj.get("ContentType"),
        passthrough_formats=limits.passthrough_formats,
        max_base64_bytes=limits.max_base64_bytes,
        max_edge=limits.max_edge,
    )
    del data
    # Dimensions/sizes only — never pixel data or base64.
    logger.info("Attachment %s: %s", s3_key, result.log_summary())
    return base64.b64encode(result.data).decode("ascii"), result.media_type
