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
asyncio's shared default executor. Results are data-URL strings in the shared
attachment cache (graph/attachment_cache.py), backed by a local-disk cache, so
a continuing conversation doesn't refetch and reconvert the same images on
every turn — also when several image-heavy conversations take turns (each
replay walks its images in order, which defeats any LRU smaller than the
combined working set). The vendors of one turn share one preparation and one
string per image: a passthrough result (the uploaded bytes) is reused by every
vendor whose limits it also fits. Failures are remembered for a few minutes so
an unusable file isn't re-downloaded on every turn. A camera RAW too large to
hold in memory is streamed to a temporary file for the RAW decoder instead
(see _normalize_large_camera_raw).
"""
import base64
import hashlib
import logging
import os
import tempfile
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

import boto3
import urllib3
from botocore.exceptions import BotoCoreError, ClientError

from encoding_library.observability import count
from graph import image_normalize
from graph.attachment_cache import CACHE
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


@dataclass(frozen=True)
class PreparedImage:
    """An attachment ready for a data-URL image block. `data_url` is the one
    string every request sending this image shares."""
    data_url: str
    media_type: str
    nbytes: int
    size: tuple[int, int]
    passthrough: bool


def _prepared(data: bytes, media_type: str, size: tuple[int, int], passthrough: bool) -> PreparedImage:
    url = (f"data:{media_type};base64,".encode("ascii") + base64.b64encode(data)).decode("ascii")
    return PreparedImage(url, media_type, len(data), size, passthrough)


def _cost(prepared: PreparedImage) -> int:
    return len(prepared.data_url)


def _image_key(s3_key: str, limits: ImageLimits):
    return ("image", s3_key, limits)


def _passthrough_key(s3_key: str):
    return ("image-passthrough", s3_key)


def _reusable(s3_key: str, limits: ImageLimits) -> PreparedImage | None:
    """A passthrough of this image prepared for another vendor, when it also
    fits `limits`: passthrough depends on the limits only through the format,
    the size and the edge (image_normalize.fits_limits)."""
    passthrough = CACHE.get(_passthrough_key(s3_key))
    if passthrough is not None and image_normalize.fits_limits(
            passthrough.media_type, passthrough.nbytes, passthrough.size, limits):
        return passthrough
    return None


# A failure may be transient (memory pressure from other requests, a codec
# out-of-memory reported as a decode error), so it is retried after this.
_FAILURE_TTL_S = 600
# Failures that depend only on the file (the camera RAW decoder's verdict)
# are remembered per S3 key, whatever the request's limits, for longer: a
# camera RAW may be a 400 MiB download.
_FILE_FAILURE_TTL_S = 6 * 3600


class _FailureMemory:
    """Remembered failures — (exception type, message, expiry) by
    (s3_key, ImageLimits), or by (s3_key, None) for file-only ones — kept
    apart from the result LRU, where image-heavy conversations would push
    these few hundred bytes out. Bounded by count, oldest dropped first."""

    def __init__(self, max_entries: int = 4096):
        self._max_entries = max_entries
        self._entries: OrderedDict = OrderedDict()
        self._lock = threading.Lock()

    def remember(self, key, e: ImageNormalizationError, ttl_s: float) -> None:
        with self._lock:
            self._entries.pop(key, None)
            self._entries[key] = (type(e), str(e), time.monotonic() + ttl_s)
            while len(self._entries) > self._max_entries:
                self._entries.popitem(last=False)

    def raise_if_remembered(self, key) -> None:
        with self._lock:
            entry = self._entries.get(key)
            if entry is not None and time.monotonic() >= entry[2]:
                del self._entries[key]  # retry: the failure may have been transient
                entry = None
        if entry is not None:
            raise entry[0](entry[1])  # a fresh instance: re-raising one would grow its traceback

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()


_FAILURES = _FailureMemory()


class _DiskCache:
    """Normalized bytes on local disk, keyed by (s3_key, ImageLimits) — or
    (s3_key, None) for a passthrough, which serves every vendor it fits —
    oldest (by last use) evicted past max_bytes. Only the image worker thread
    touches it. Best effort: any filesystem error just means a miss."""

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
        if limits is None:
            ident = f"{s3_key}|passthrough"
        else:
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


def _raise_if_remembered(s3_key: str, limits: ImageLimits) -> None:
    _FAILURES.raise_if_remembered((s3_key, None))
    _FAILURES.raise_if_remembered((s3_key, limits))


async def image_data_url(s3_key: str, limits: ImageLimits) -> str:
    """The `data:<media type>;base64,...` URL of an attachment within `limits`,
    shared with every other request sending it.

    Cache hits return immediately; misses queue on the dedicated image worker.
    Raises ImageNormalizationError (user-readable) when the file can't be used,
    RuntimeError on missing bucket configuration.
    """
    _raise_if_remembered(s3_key, limits)
    prepared = CACHE.get(_image_key(s3_key, limits))
    if prepared is not None:
        count("attachment_cache_total", data_type="image", status="hit")
        return prepared.data_url
    prepared = _reusable(s3_key, limits)
    if prepared is not None:
        count("attachment_cache_total", data_type="image", status="reused")
        return prepared.data_url
    prepared = await CACHE.get_or_prepare(
        _image_key(s3_key, limits), lambda: prepare_image(s3_key, limits), _IMAGE_POOL,
        cost=_cost, data_type="image",
    )
    return prepared.data_url


def prepare_image(s3_key: str, limits: ImageLimits) -> PreparedImage:
    """Synchronous core of image_data_url (runs on the image worker). The media
    type is that of the bytes actually sent (sniffed/converted), never the
    uploader's declaration."""
    _raise_if_remembered(s3_key, limits)
    reused = _reusable(s3_key, limits)
    if reused is not None:
        return reused
    on_disk = _DISK_CACHE.get((s3_key, None))
    if on_disk is not None:
        data, media_type = on_disk
        passthrough = _prepared(data, media_type, image_normalize.image_size(data), passthrough=True)
        CACHE.put(_passthrough_key(s3_key), passthrough, _cost(passthrough))
        if image_normalize.fits_limits(media_type, len(data), passthrough.size, limits):
            return passthrough
    on_disk = _DISK_CACHE.get((s3_key, limits))
    if on_disk is not None:
        data, media_type = on_disk
        return _prepared(data, media_type, image_normalize.image_size(data), passthrough=False)
    try:
        normalized = _fetch_normalized(s3_key, limits)
    except ImageTemporarilyUnavailableError:
        raise
    except ImageNormalizationError as e:
        # Unsupported / too large is usually a property of the (immutable)
        # object and the limits: remember it for a while instead of
        # re-downloading it every turn.
        if getattr(e, "file_only", False):
            _FAILURES.remember((s3_key, None), e, _FILE_FAILURE_TTL_S)
        else:
            _FAILURES.remember((s3_key, limits), e, _FAILURE_TTL_S)
        raise
    passthrough = normalized.strategy == "passthrough"
    _DISK_CACHE.put((s3_key, None if passthrough else limits), normalized.data, normalized.media_type)
    prepared = _prepared(normalized.data, normalized.media_type, normalized.output_size, passthrough)
    if passthrough:
        CACHE.put(_passthrough_key(s3_key), prepared, _cost(prepared))
    return prepared


# Errors reading from S3. StreamingBody wraps most urllib3 errors in botocore
# ones, but not all (e.g. SSLError).
_S3_ERRORS = (ClientError, BotoCoreError, urllib3.exceptions.HTTPError)


def _fetch_normalized(s3_key: str, limits: ImageLimits) -> image_normalize.NormalizedImage:
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
    return result


# Enough of an object's start to recognize a camera RAW: magic numbers and,
# in most TIFF-based RAWs, the first IFD (right after the header).
_RAW_HEAD_BYTES = 256 * 1024
# A first IFD of up to 1024 entries, read separately when it doesn't fit in the head.
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
    """camera_raw_kind() for a TIFF whose first IFD doesn't fit in `head`
    (writers such as dnglab put it at the end), from a ranged read of just
    that IFD."""
    offset = image_normalize.tiff_ifd0_offset(head)
    if offset is None or offset >= size or offset + _IFD_BYTES <= len(head):
        return None  # not a TIFF, or its first IFD was already judged from the head
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
