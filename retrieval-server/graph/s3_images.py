"""Fetches attachment images from S3 as base64 for multimodal LLM calls.

The proxy server only sends S3 keys (never bytes) — this module resolves them
at LLM-call time. A small LRU cache avoids refetching the same images on every
turn when a conversation with attachments continues.
"""
import base64
import functools
import logging
import os

import boto3

logger = logging.getLogger(__name__)

_s3_client = None


def _client():
    global _s3_client
    if _s3_client is None:
        _s3_client = boto3.client("s3")
    return _s3_client


@functools.lru_cache(maxsize=16)
def fetch_image_base64(s3_key: str) -> str:
    """Base64 of the object's bytes. Raises on missing bucket config or fetch failure."""
    bucket = os.environ.get("ATTACHMENTS_BUCKET", "")
    if not bucket:
        raise RuntimeError("ATTACHMENTS_BUCKET environment variable is not set")
    obj = _client().get_object(Bucket=bucket, Key=s3_key)
    data = obj["Body"].read()
    logger.info("Fetched attachment %s from S3 (%d bytes)", s3_key, len(data))
    return base64.b64encode(data).decode("ascii")
