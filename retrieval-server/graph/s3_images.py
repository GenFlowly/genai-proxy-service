"""Fetches attachment images from S3, normalized for multimodal LLM calls.

The proxy server only sends S3 keys (never bytes) — this module resolves them
at LLM-call time. Uploads are unrestricted (any type, any size), so every
object goes through graph/image_normalize.py, which sniffs the real format and
returns bytes + media type the target vendor accepts (passthrough when already
fine, otherwise lossless conversion/downscale). The original S3 object is never
modified. A small LRU cache keeps the normalized result so a continuing
conversation doesn't refetch and reconvert the same images on every turn.
"""
import base64
import functools
import logging
import os

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from graph import image_normalize
from graph.image_normalize import ImageNormalizationError, ImageTooLargeError

logger = logging.getLogger(__name__)

_s3_client = None


class AttachmentFetchError(ImageNormalizationError):
    """The attachment object could not be read from S3 (user-readable)."""


def _client():
    global _s3_client
    if _s3_client is None:
        _s3_client = boto3.client("s3")
    return _s3_client


def fetch_image_for_llm(s3_key: str, provider: str | None = None) -> tuple[str, str]:
    """(base64, media_type) of an attachment, ready for a data-URL image block.

    The media type is that of the bytes actually returned (sniffed/converted),
    never the uploader's declaration. `provider` selects which formats may be
    passed through untouched (see image_normalize.passthrough_formats_for).
    Raises ImageNormalizationError (user-readable) when the file can't be used,
    RuntimeError on missing bucket configuration.
    """
    return _fetch_normalized(s3_key, image_normalize.passthrough_formats_for(provider))


@functools.lru_cache(maxsize=16)
def _fetch_normalized(s3_key: str, passthrough_formats: frozenset[str]) -> tuple[str, str]:
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
        raise AttachmentFetchError(
            f"An attached image could not be loaded from storage ({code}). Please attach it again."
        ) from e

    result = image_normalize.normalize_image(
        data, obj.get("ContentType"), passthrough_formats=passthrough_formats,
    )
    # Dimensions/sizes only — never pixel data or base64.
    logger.info("Attachment %s: %s", s3_key, result.log_summary())
    return base64.b64encode(result.data).decode("ascii"), result.media_type
