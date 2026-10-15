#!/usr/bin/env python3
"""Check the vendored mitex Typst package against its pins and, when reachable,
against the published tarball on packages.typst.org (stdlib only).

graph_tools/typst_packages/preview/mitex/0.2.7 is a verbatim copy of
https://packages.typst.org/preview/mitex-0.2.7.tar.gz. The Typst renderer
loads it through package_path, with an empty read-only package cache, so
nothing is ever downloaded at render time.

Usage (from retrieval-server/):

    python scripts/verify_mitex.py             # pins, then upstream if reachable
    python scripts/verify_mitex.py --offline   # pins only
    python scripts/verify_mitex.py --require-upstream   # fail when unreachable

Exit 0 when everything checked matches (an unreachable upstream is reported
as skipped), 1 on any mismatch. Nothing from the tarball is executed or
written to disk; members are read in memory.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import os
import sys
import tarfile
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PACKAGE_DIR = os.path.normpath(os.path.join(HERE, "..", "graph_tools", "typst_packages",
                                            "preview", "mitex", "0.2.7"))
UPSTREAM_URL = "https://packages.typst.org/preview/mitex-0.2.7.tar.gz"

# sha256 of every vendored file (also listed in graph_tools/typst_packages/README.md).
PINNED = {
    "lib.typ": "b83008d32114fa6f0b81df7684fc15ad9a0718e952b566564b2b56ae0fc7cd89",
    "mitex.typ": "da42e95fd8e19c734069379f8890ccebf0c48ff3a1a3469b6ec2f01e7fc36871",
    "mitex.wasm": "f30000cbc2b18a6cdc72c3ce539d3ac443faa9109b4e0272cd274b37c6c1cff7",
    "specs/latex/standard.typ": "6fab6c35ede2e87d090c4ad7d9223d9544f6a3e0815ecf1788a7a0b3393af060",
    "specs/mod.typ": "2304c350546cef345a6130db236b5359836cfde11f4337636e13ad60a006ebf4",
    "specs/prelude.typ": "3a6de0070bf294167d43d09b4c633029512d9cfdb4eaf7a729ce5fe75e58515d",
    "typst.toml": "8c30fad1454efbfe72aaf241f5ced8c8103fec7e2790f9b1ebef0e01e335503c",
}


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def vendored_files(package_dir: str = PACKAGE_DIR) -> dict[str, str]:
    """{relative path: sha256} of every file in the vendored package directory."""
    out = {}
    for base, _dirs, files in os.walk(package_dir):
        for name in files:
            path = os.path.join(base, name)
            rel = os.path.relpath(path, package_dir).replace(os.sep, "/")
            with open(path, "rb") as f:
                out[rel] = _sha256(f.read())
    return out


def check_pins(package_dir: str = PACKAGE_DIR) -> list[str]:
    """Problems found comparing the vendored directory with PINNED (empty = OK)."""
    have = vendored_files(package_dir)
    problems = [f"missing {rel}" for rel in sorted(PINNED) if rel not in have]
    problems += [f"modified {rel}" for rel in sorted(PINNED) if rel in have and have[rel] != PINNED[rel]]
    problems += [f"unexpected file {rel}" for rel in sorted(have) if rel not in PINNED]
    return problems


def fetch_upstream(url: str = UPSTREAM_URL, timeout: float = 30.0) -> bytes | None:
    """The upstream tarball, or None when packages.typst.org cannot be reached."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            data = resp.read(16 * 1024 * 1024 + 1)
    except (urllib.error.URLError, OSError, TimeoutError):
        return None
    if len(data) > 16 * 1024 * 1024:
        raise ValueError("upstream tarball larger than expected")
    return data


def compare_upstream(tarball: bytes, package_dir: str = PACKAGE_DIR) -> list[str]:
    have = vendored_files(package_dir)
    upstream: dict[str, str] = {}
    with tarfile.open(fileobj=io.BytesIO(tarball), mode="r:gz") as tf:
        for member in tf.getmembers():
            if not member.isreg():
                continue
            rel = member.name[2:] if member.name.startswith("./") else member.name
            upstream[rel] = _sha256(tf.extractfile(member).read())
    problems = [f"not vendored: {rel}" for rel in sorted(upstream) if rel not in have]
    problems += [f"differs from upstream: {rel}" for rel in sorted(upstream)
                 if rel in have and have[rel] != upstream[rel]]
    problems += [f"not in upstream: {rel}" for rel in sorted(have) if rel not in upstream]
    return problems


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Verify the vendored mitex 0.2.7 package.")
    ap.add_argument("--offline", action="store_true", help="check the pinned hashes only")
    ap.add_argument("--require-upstream", action="store_true",
                    help="fail instead of skipping when packages.typst.org is unreachable")
    args = ap.parse_args(argv)

    problems = check_pins()
    for p in problems:
        print(f"verify_mitex: {p}")
    if problems:
        return 1
    print(f"verify_mitex: {len(PINNED)} vendored files match their pinned sha256")
    if args.offline:
        return 0
    tarball = fetch_upstream()
    if tarball is None:
        print("verify_mitex: packages.typst.org unreachable, upstream comparison skipped")
        return 1 if args.require_upstream else 0
    problems = compare_upstream(tarball)
    for p in problems:
        print(f"verify_mitex: {p}")
    if problems:
        return 1
    print("verify_mitex: vendored files are identical to mitex-0.2.7.tar.gz on packages.typst.org")
    return 0


if __name__ == "__main__":
    sys.exit(main())
