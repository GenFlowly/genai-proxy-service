"""Artifact storage backends.

Tools never talk to storage APIs directly — they receive an ArtifactStore via
ToolContext, so the same tool works against S3 in production and a local
directory in tests or open-source deployments.
"""
import logging
import os
from typing import Protocol

logger = logging.getLogger(__name__)


class ArtifactStore(Protocol):
    def put(self, key: str, data: bytes, content_type: str) -> None:
        """Persist `data` under `key`. Raises on failure."""
        ...


class LocalDiskArtifactStore:
    """Writes artifacts under a base directory, mirroring the key as a path."""

    def __init__(self, base_dir: str):
        self._base_dir = base_dir

    def put(self, key: str, data: bytes, content_type: str) -> None:
        path = os.path.join(self._base_dir, *key.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        logger.info("Stored artifact %s (%d bytes) at %s", key, len(data), path)


class S3ArtifactStore:
    """Writes artifacts to an S3 bucket. boto3 is imported lazily so the
    package stays installable without AWS dependencies."""

    def __init__(self, bucket: str, client=None):
        if not bucket:
            raise ValueError("S3ArtifactStore requires a bucket name")
        self._bucket = bucket
        self._client = client

    def _s3(self):
        if self._client is None:
            import boto3

            self._client = boto3.client("s3")
        return self._client

    def put(self, key: str, data: bytes, content_type: str) -> None:
        self._s3().put_object(
            Bucket=self._bucket, Key=key, Body=data, ContentType=content_type
        )
        logger.info(
            "Stored artifact %s (%d bytes) in s3://%s", key, len(data), self._bucket
        )
