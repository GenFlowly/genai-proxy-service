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
asyncio's shared default executor. Results are kept in a byte-bounded
in-memory LRU backed by a local-disk cache, so a continuing conversation
doesn't refetch and reconvert the same images on every turn — also when
several image-heavy conversations take turns (each replay walks its images in
order, which defeats any LRU smaller than the combined working set). Failures
are remembered for a few minutes so an unusable file isn't re-downloaded on
every turn. A camera RAW too large to hold in memory is streamed to a
temporary file for the RAW decoder instead (see _normalize_large_camera_raw).
"""
import asyncio
import base64
import hashlib
import logging
import os
import tempfile
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor

import boto3
import urllib3
from botocore.exceptions import BotoCoreError, ClientError

from graph import image_normalize
from graph.image_normalize import (
    ImageLimits,
    ImageNormalizationError,
    ImageTemporarilyUnavailableError,
    ImageTooLargeError,
)

logger = logging.getLogger(__name__)

_s3_client = None

_IMAGE_POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="attachment-image")


class AttachmentFetchError(ImageTemporarilyUnavailableError):
    """The attachment object could not be read from S3 (user-readable).
    Transient by nature, so never cached."""


class _ByteBoundedLRU:
    """LRU keyed by (s3_key, ImageLimits) — or (s3_key, None) for failures
    that depend only on the file — holding (base64, media_type) results or
    remembered failures, bounded by total base64 size rather than entry
    count. S3 keys are immutable (fresh UUID per upload), so results never go
    stale; failures expire (see _FAILURE_TTL_S)."""

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
# A failure may be transient (memory pressure from other requests, a codec
# out-of-memory reported as a decode error), so it is retried after this.
_FAILURE_TTL_S = 600
# Failures that depend only on the file (the camera RAW decoder's verdict)
# are remembered per S3 key, whatever the request's limits, for longer: a
# camera RAW may be a 400 MiB download.
_FILE_FAILURE_TTL_S = 6 * 3600


class _DiskCache:
    """Normalized bytes on local disk, keyed by (s3_key, ImageLimits), oldest
    (by last use) evicted past max_bytes. Only the image worker thread touches
    it. Best effort: any filesystem error just means a miss."""

    _EXT = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"}
    _TYPE = {v: k for k, v in _EXT.items()}

    def __init__(self, directory: str, max_bytes: int):
        self._dir = directory
        self._max_bytes = max_bytes
        self._bytes: int | None = None  # lazily summed from the directory
        self._dir_ready = False

    @staticmethod
    def _name(key) -> str:
        s3_key, limits = key
        ident = f"{s3_key}|{sorted(limits.passthrough_formats)}|{limits.max_base64_bytes}|{limits.max_edge}"
        return hashlib.sha256(ident.encode()).hexdigest()

    def _paths(self, key):
        name = self._name(key)
        return [os.path.join(self._dir, f"{name}.{ext}") for ext in self._EXT.values()]

    def get(self, key) -> tuple[bytes, str] | None:
        if self._max_bytes <= 0:
            return None
        for path in self._paths(key):
            try:
                with open(path, "rb") as f:
                    data = f.read()
                os.utime(path)  # last use, for eviction
                return data, self._TYPE[path.rsplit(".", 1)[1]]
            except OSError:
                continue
        return None

    def put(self, key, data: bytes, media_type: str) -> None:
        ext = self._EXT.get(media_type)
        if self._max_bytes <= 0 or ext is None or len(data) > self._max_bytes:
            return
        try:
            self._ensure_dir()
            if self._bytes is None:
                self._bytes = sum(e.stat().st_size for e in os.scandir(self._dir) if e.is_file())
            path = os.path.join(self._dir, f"{self._name(key)}.{ext}")
            tmp = f"{path}.tmp"
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, path)
            self._bytes += len(data)
            if self._bytes > self._max_bytes:
                self._evict()
        except OSError as e:
            logger.debug("Image disk cache write failed: %s", e)

    def _ensure_dir(self) -> None:
        """Private to the server's user: the camera RAW decoder runs as
        another user and must not read anyone's cached attachments."""
        if self._dir_ready:
            return
        os.makedirs(self._dir, mode=0o700, exist_ok=True)
        try:
            os.chmod(self._dir, 0o700)
        except OSError:
            pass  # a configured directory we don't own: leave its mode alone
        self._dir_ready = True

    def _evict(self) -> None:
        entries = sorted(
            (e for e in os.scandir(self._dir) if e.is_file()), key=lambda e: e.stat().st_mtime,
        )
        total = sum(e.stat().st_size for e in entries)
        for entry in entries:
            if total <= self._max_bytes * 0.9:
                break
            try:
                size = entry.stat().st_size
                os.remove(entry.path)
                total -= size
            except OSError:
                continue
        self._bytes = total


_DISK_CACHE = _DiskCache(
    os.environ.get("IMAGE_DISK_CACHE_DIR") or os.path.join(tempfile.gettempdir(), "attachment-images"),
    image_normalize._env_int("IMAGE_DISK_CACHE_BYTES", 512 * 1024 * 1024),
)


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
    if isinstance(value, tuple) and len(value) == 3 and isinstance(value[0], type):
        error_type, message, expires = value
        if time.monotonic() >= expires:
            return None  # retry: the failure may have been transient
        raise error_type(message)  # a fresh instance: re-raising one would grow its traceback
    return value


async def image_for_llm(s3_key: str, limits: ImageLimits) -> tuple[str, str]:
    """(base64, media_type) of an attachment, ready for a data-URL image block.

    Cache hits return immediately; misses queue on the dedicated image worker.
    Raises ImageNormalizationError (user-readable) when the file can't be used,
    RuntimeError on missing bucket configuration.
    """
    cached = _from_cache((s3_key, limits)) or _from_cache((s3_key, None))
    if cached is not None:
        return cached
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_IMAGE_POOL, fetch_image_for_llm, s3_key, limits)


def fetch_image_for_llm(s3_key: str, limits: ImageLimits) -> tuple[str, str]:
    """Synchronous core of image_for_llm (runs on the image worker). The media
    type is that of the bytes actually returned (sniffed/converted), never the
    uploader's declaration."""
    key = (s3_key, limits)
    cached = _from_cache(key) or _from_cache((s3_key, None))
    if cached is not None:
        return cached
    on_disk = _DISK_CACHE.get(key)
    if on_disk is not None:
        result = base64.b64encode(on_disk[0]).decode("ascii"), on_disk[1]
        _CACHE.put(key, result, cost=len(result[0]))
        return result
    try:
        data, media_type = _fetch_normalized(s3_key, limits)
    except ImageTemporarilyUnavailableError:
        raise
    except ImageNormalizationError as e:
        # Unsupported / too large is usually a property of the (immutable)
        # object and the limits: remember it for a while instead of
        # re-downloading it every turn.
        if getattr(e, "file_only", False):
            _CACHE.put((s3_key, None), (type(e), str(e), time.monotonic() + _FILE_FAILURE_TTL_S), cost=len(str(e)) + 256)
        else:
            _CACHE.put(key, (type(e), str(e), time.monotonic() + _FAILURE_TTL_S), cost=len(str(e)) + 256)
        raise
    _DISK_CACHE.put(key, data, media_type)
    result = base64.b64encode(data).decode("ascii"), media_type
    _CACHE.put(key, result, cost=len(result[0]))
    return result


# Errors reading from S3. StreamingBody wraps most urllib3 errors in botocore
# ones, but not all (e.g. SSLError).
_S3_ERRORS = (ClientError, BotoCoreError, urllib3.exceptions.HTTPError)


def _fetch_normalized(s3_key: str, limits: ImageLimits) -> tuple[bytes, str]:
    bucket = os.environ.get("ATTACHMENTS_BUCKET", "")
    if not bucket:
        raise RuntimeError("ATTACHMENTS_BUCKET environment variable is not set")
    try:
        obj = _client().get_object(Bucket=bucket, Key=s3_key)
        # Operational OOM guard, checked before the body is read into memory.
        size = obj.get("ContentLength")
        if size is not None and size > image_normalize.MAX_SOURCE_BYTES:
            result = _normalize_large_camera_raw(bucket, s3_key, obj, size, limits)
        else:
            data = obj["Body"].read()
            result = None
    except _S3_ERRORS as e:
        raise _fetch_error(s3_key, e) from e

    if result is None:
        result = image_normalize.normalize_image(
            data, obj.get("ContentType"),
            passthrough_formats=limits.passthrough_formats,
            max_base64_bytes=limits.max_base64_bytes,
            max_edge=limits.max_edge,
        )
        del data
    # Dimensions/sizes only — never pixel data or base64.
    logger.info("Attachment %s: %s", s3_key, result.log_summary())
    return result.data, result.media_type


# Enough of an object's start to recognize a camera RAW: magic numbers and,
# in most TIFF-based RAWs, the first IFD (right after the header).
_RAW_HEAD_BYTES = 256 * 1024
# A first IFD of up to 1024 entries, read separately when it lies past the head.
_IFD_BYTES = 2 + 12 * 1024 + 4


def _normalize_large_camera_raw(bucket: str, s3_key: str, obj: dict, size: int,
                                limits: ImageLimits) -> image_normalize.NormalizedImage:
    """An object over MAX_SOURCE_BYTES: only a camera RAW (phone DNGs and
    uncompressed or medium-format RAWs are often that large), recognized by
    its structure, up to MAX_RAW_SOURCE_BYTES is processed — streamed
    straight to a file the RAW child reads, never held in memory. Anything
    else is refused after a peek at its start. S3 read errors propagate."""
    body = obj["Body"]
    try:
        head = body.read(_RAW_HEAD_BYTES)
        raw_kind = image_normalize.camera_raw_kind(head) or _raw_kind_of_late_ifd0(bucket, s3_key, head, size)
        if raw_kind is None:
            raise ImageTooLargeError(image_normalize.source_too_large_message(size, image_normalize.MAX_SOURCE_BYTES))
        if size > image_normalize.MAX_RAW_SOURCE_BYTES:
            raise ImageTooLargeError(image_normalize.source_too_large_message(size, image_normalize.MAX_RAW_SOURCE_BYTES))
        try:
            spool = image_normalize.camera_raw_spool()
        except OSError as e:
            raise image_normalize.spool_unavailable(e) from e
        with spool:
            try:
                spool.write(head)
                del head
                while chunk := body.read(1024 * 1024):
                    spool.write(chunk)
                spool.flush()
            except _S3_ERRORS:
                raise  # a read error (a read timeout is an OSError too): see _fetch_normalized
            except OSError as e:
                raise image_normalize.spool_unavailable(e) from e
            return image_normalize.normalize_camera_raw_file(
                spool.name, size, obj.get("ContentType"), raw_kind,
                max_base64_bytes=limits.max_base64_bytes, max_edge=limits.max_edge,
            )
    finally:
        body.close()


def _raw_kind_of_late_ifd0(bucket: str, s3_key: str, head: bytes, size: int) -> str | None:
    """camera_raw_kind() for a TIFF whose first IFD lies past `head` (writers
    such as dnglab put it at the end), from a ranged read of just that IFD."""
    offset = image_normalize.tiff_ifd0_offset(head)
    if offset is None or not len(head) <= offset < size:
        return None
    ifd = _client().get_object(Bucket=bucket, Key=s3_key, Range=f"bytes={offset}-{offset + _IFD_BYTES - 1}")
    try:
        return image_normalize.camera_raw_kind_with_ifd0(head, ifd["Body"].read())
    finally:
        ifd["Body"].close()


def _fetch_error(s3_key: str, e: Exception) -> AttachmentFetchError:
    response = getattr(e, "response", None) or {}  # None on botocore's HTTP client errors
    code = response.get("Error", {}).get("Code") or type(e).__name__
    logger.warning("Attachment %s could not be read from S3: %s", s3_key, code)
    if code in ("NoSuchKey", "404", "NotFound"):
        return AttachmentFetchError("An attached image is no longer available. Please attach it again.")
    return AttachmentFetchError("An attached image could not be loaded right now. Please try again.")
