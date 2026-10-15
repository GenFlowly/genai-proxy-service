"""Artifact storage backends.

Tools never talk to storage APIs directly — they receive an ArtifactStore via
ToolContext, so the same tool works against S3 in production and a local
directory in tests or open-source deployments.
"""
import logging
import os
import unicodedata
from typing import Protocol
from urllib.parse import quote, urlencode

logger = logging.getLogger(__name__)


class ArtifactStore(Protocol):
    def put(
        self,
        key: str,
        data: bytes,
        content_type: str,
        *,
        tags: dict | None = None,
        filename: str | None = None,
    ) -> None:
        """Persist `data` under `key`. Raises on failure.

        `tags` are object tags (key -> value) stored with the object, e.g. a
        retention class a lifecycle rule expires on. `filename` is the name a
        browser should save the object as (S3: Content-Disposition). Backends
        that cannot store either ignore them."""
        ...

    def get(self, key: str) -> bytes:
        """Read the object at `key`. Raises KeyError when it does not exist,
        any other exception on infrastructure failure."""
        ...

    def list(self, prefix: str) -> list[dict]:
        """Objects under `prefix` as [{"key": str, "size": int}, ...]."""
        ...


class LocalDiskArtifactStore:
    """Stores artifacts under a base directory, mirroring the key as a path."""

    def __init__(self, base_dir: str):
        self._base_dir = base_dir

    def _path(self, key: str) -> str:
        return os.path.join(self._base_dir, *key.split("/"))

    def put(
        self,
        key: str,
        data: bytes,
        content_type: str,
        *,
        tags: dict | None = None,
        filename: str | None = None,
    ) -> None:
        path = self._path(key)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        logger.info("Stored artifact %s (%d bytes) at %s", key, len(data), path)

    def get(self, key: str) -> bytes:
        path = self._path(key)
        if not os.path.isfile(path):
            raise KeyError(key)
        with open(path, "rb") as f:
            return f.read()

    def list(self, prefix: str) -> list[dict]:
        base = self._path(prefix)
        out: list[dict] = []
        if not os.path.isdir(base):
            return out
        for root, _dirs, files in os.walk(base):
            for name in files:
                path = os.path.join(root, name)
                rel = os.path.relpath(path, self._base_dir).replace(os.sep, "/")
                out.append({"key": rel, "size": os.path.getsize(path)})
        return sorted(out, key=lambda o: o["key"])


class S3ArtifactStore:
    """Stores artifacts in an S3 bucket. boto3 is imported lazily so the
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

    def put(
        self,
        key: str,
        data: bytes,
        content_type: str,
        *,
        tags: dict | None = None,
        filename: str | None = None,
    ) -> None:
        kwargs: dict = {
            "Bucket": self._bucket, "Key": key, "Body": data, "ContentType": content_type,
        }
        if tags:
            # S3 takes tags on PutObject as a URL-encoded query string.
            kwargs["Tagging"] = urlencode({str(k): str(v) for k, v in tags.items()})
        if filename:
            kwargs["ContentDisposition"] = content_disposition(filename)
        self._s3().put_object(**kwargs)
        logger.info(
            "Stored artifact %s (%d bytes) in s3://%s", key, len(data), self._bucket
        )

    def get(self, key: str) -> bytes:
        try:
            response = self._s3().get_object(Bucket=self._bucket, Key=key)
        except Exception as e:
            # Missing-key surfaces uniformly as KeyError; anything else
            # (permissions, networking) propagates as the infrastructure
            # failure it is.
            if type(e).__name__ in ("NoSuchKey",) or "NoSuchKey" in str(e):
                raise KeyError(key) from e
            raise
        return response["Body"].read()

    def list(self, prefix: str) -> list[dict]:
        out: list[dict] = []
        paginator = self._s3().get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self._bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                out.append({"key": obj["Key"], "size": obj["Size"]})
        return out


def content_disposition(filename: str) -> str:
    """An `inline` Content-Disposition carrying `filename` safely.

    RFC 6266/5987: an ASCII-only `filename=` fallback (quotes, backslashes and
    control characters removed) plus `filename*=UTF-8''<percent-encoded>` for
    the real name, so browsers save "résumé.pdf" instead of the object's UUID
    key while no header injection is possible."""
    folded = unicodedata.normalize("NFKD", filename).encode("ascii", "ignore").decode("ascii")
    ascii_name = " ".join(
        "".join(ch for ch in folded if ch.isprintable() and ch not in '"\\').split()
    )
    stem, dot, ext = ascii_name.rpartition(".")
    if not ascii_name or (dot and not stem.strip()):
        # Nothing ASCII survived (e.g. a Chinese name): keep the extension.
        ascii_name = f"download.{ext}" if dot and ext else "download"
    return f"inline; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename, safe='')}"
