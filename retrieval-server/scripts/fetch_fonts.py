#!/usr/bin/env python3
"""Fetch the bundled PDF fonts into graph_tools/fonts/ (stdlib only).

The Typst renderer (graph_tools/tools/pdf_typst.py) draws text only with the
fonts in graph_tools/fonts/ (ignore_system_fonts=True). The font binaries are
not committed: this script downloads the npm tarballs of the
@expo-google-fonts packages pinned in graph_tools/fonts/fonts.lock.json
(Google Fonts' static TTF builds, SIL OFL 1.1), checks each tarball against
the npm `dist.integrity` (sha512) pinned in the lock, extracts only the listed
TTF members, and checks each extracted file against its pinned sha256.

Usage (from retrieval-server/):

    python scripts/fetch_fonts.py            # fetch what is missing or stale
    python scripts/fetch_fonts.py --check    # verify only, no network (exit 1 on mismatch)
    python scripts/fetch_fonts.py --cache-dir ~/.cache/genflowly-fonts   # reuse tarballs

Nothing from a tarball is executed, and nothing but the listed members is
read (no extractall, so no path traversal). Re-running is a no-op when every
file is present with its pinned hash.

A lock entry may list `drop_tables`: the extracted font is rewritten without
those sfnt tables (a plain table-directory rewrite, no glyph changes) and the
result must match `output_sha256`. Noto Color Emoji uses this to drop its 20 MB
'SVG ' table: Typst 0.15 draws the COLRv1 table, so the SVG copy is dead weight
(and slow if Typst ever fell back to it).

After fetching, the script (re)writes graph_tools/fonts/coverage.json: the
merged code point ranges that the bundled fonts map to a glyph (read from each
font's cmap table). The server reads it through pdf_typst.fonts_cover() to
decide whether every script in a document has a bundled font, without loading
any font or importing typst. The file is committed; `--check` verifies it.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import math
import os
import struct
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DEST = os.path.normpath(os.path.join(HERE, "..", "graph_tools", "fonts"))
MAX_TARBALL_BYTES = 200 * 1024 * 1024
MAX_MEMBER_BYTES = 64 * 1024 * 1024


class FetchError(Exception):
    pass


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _check_integrity(data: bytes, integrity: str) -> None:
    algo, _, expected = integrity.partition("-")
    if algo not in ("sha512", "sha384", "sha256"):
        raise FetchError(f"unsupported integrity algorithm {algo!r}")
    actual = base64.b64encode(hashlib.new(algo, data).digest()).decode("ascii")
    if actual != expected:
        raise FetchError("tarball integrity mismatch")


def _tarball_url(registry: str, name: str, version: str) -> str:
    base = name.rsplit("/", 1)[-1]
    return f"{registry.rstrip('/')}/{name}/-/{base}-{version}.tgz"


def _download(url: str, attempts: int = 3) -> bytes:
    last: Exception | None = None
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=300) as resp:
                buf = io.BytesIO()
                while True:
                    chunk = resp.read(1 << 20)
                    if not chunk:
                        break
                    buf.write(chunk)
                    if buf.tell() > MAX_TARBALL_BYTES:
                        raise FetchError("tarball larger than the size limit")
                return buf.getvalue()
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            last = exc
            time.sleep(2 * (attempt + 1))
    raise FetchError(f"download failed: {url}: {last}")


def _calc_checksum(data: bytes) -> int:
    padded = data + b"\0" * ((4 - len(data) % 4) % 4)
    total = 0
    for (word,) in struct.iter_unpack(">I", padded):
        total = (total + word) & 0xFFFFFFFF
    return total


def drop_sfnt_tables(data: bytes, drop: set[str]) -> bytes:
    """Rewrite a single-font sfnt (TTF/OTF) without the given tables."""
    if len(data) < 12:
        raise FetchError("not an sfnt font")
    version, num_tables = struct.unpack(">IH", data[:6])
    if version not in (0x00010000, 0x4F54544F, 0x74727565):  # TrueType, 'OTTO', 'true'
        raise FetchError("unsupported sfnt version")
    entries = []
    for i in range(num_tables):
        tag, _cs, off, length = struct.unpack(">4sIII", data[12 + 16 * i:28 + 16 * i])
        if off + length > len(data):
            raise FetchError("truncated sfnt table")
        entries.append((tag, off, length))
    keep = sorted(e for e in entries if e[0].decode("latin-1") not in drop)
    n = len(keep)
    selector = int(math.floor(math.log2(n))) if n else 0
    search_range = (2 ** selector) * 16
    header = struct.pack(">IHHHH", version, n, search_range, selector, n * 16 - search_range)
    offset = 12 + 16 * n
    directory, body, head_offset = [], [], None
    for tag, off, length in keep:
        table = data[off:off + length]
        if tag == b"head":
            table = table[:8] + b"\0\0\0\0" + table[12:]  # checkSumAdjustment computed below
            head_offset = offset
        directory.append(struct.pack(">4sIII", tag, _calc_checksum(table), offset, length))
        padded = table + b"\0" * ((4 - length % 4) % 4)
        body.append(padded)
        offset += len(padded)
    font = bytearray(header + b"".join(directory) + b"".join(body))
    if head_offset is not None:
        adjustment = (0xB1B0AFBA - _calc_checksum(bytes(font))) & 0xFFFFFFFF
        font[head_offset + 8:head_offset + 12] = struct.pack(">I", adjustment)
    return bytes(font)


# --- coverage.json (keep in step with graph_tools/tools/pdf_typst._cmap_ranges;
# tests/test_pdf_typst.py checks that both readers agree) -----------------------

COVERAGE_FILENAME = "coverage.json"


def cmap_ranges(path: str) -> list[tuple[int, int]]:
    """Code point ranges a font maps to a real glyph (reads only the cmap table)."""
    with open(path, "rb") as f:
        header = f.read(12)
        if len(header) < 12:
            return []
        num_tables = struct.unpack(">H", header[4:6])[0]
        directory = f.read(16 * num_tables)
        cmap = None
        for i in range(num_tables):
            tag, _cs, off, length = struct.unpack(">4sIII", directory[16 * i:16 * i + 16])
            if tag == b"cmap":
                cmap = (off, length)
                break
        if cmap is None:
            return []
        f.seek(cmap[0])
        data = f.read(cmap[1])
    num_sub = struct.unpack(">H", data[2:4])[0]
    subtables: dict[tuple[int, int], int] = {}
    for i in range(num_sub):
        pid, eid, off = struct.unpack(">HHI", data[4 + 8 * i:12 + 8 * i])
        subtables.setdefault((pid, eid), off)

    def fmt(off: int) -> int:
        return struct.unpack(">H", data[off:off + 2])[0]

    for key in ((3, 10), (0, 6), (0, 4)):
        off = subtables.get(key)
        if off is not None and fmt(off) == 12:
            return _format12(data, off)
    for key in ((3, 1), (0, 3), (0, 2), (0, 1), (0, 0)):
        off = subtables.get(key)
        if off is not None:
            if fmt(off) == 4:
                return _format4(data, off)
            if fmt(off) == 12:
                return _format12(data, off)
    return []


def _format12(data: bytes, off: int) -> list[tuple[int, int]]:
    n_groups = struct.unpack(">I", data[off + 12:off + 16])[0]
    out = []
    for start, end, glyph in struct.iter_unpack(">III", data[off + 16:off + 16 + 12 * n_groups]):
        if glyph == 0:
            start += 1
        if start <= end:
            out.append((start, end))
    return out


def _format4(data: bytes, off: int) -> list[tuple[int, int]]:
    seg_x2 = struct.unpack(">H", data[off + 6:off + 8])[0]
    seg = seg_x2 // 2
    ends = struct.unpack(f">{seg}H", data[off + 14:off + 14 + seg_x2])
    starts = struct.unpack(f">{seg}H", data[off + 16 + seg_x2:off + 16 + 2 * seg_x2])
    deltas = struct.unpack(f">{seg}H", data[off + 16 + 2 * seg_x2:off + 16 + 3 * seg_x2])
    ro_base = off + 16 + 3 * seg_x2
    offsets = struct.unpack(f">{seg}H", data[ro_base:ro_base + seg_x2])
    out: list[tuple[int, int]] = []
    for i in range(seg):
        start, end = starts[i], ends[i]
        if start == 0xFFFF or start > end:
            continue
        if offsets[i] == 0:
            notdef = (-deltas[i]) & 0xFFFF
            if start <= notdef <= end:
                if start < notdef:
                    out.append((start, notdef - 1))
                if notdef < end:
                    out.append((notdef + 1, end))
            else:
                out.append((start, end))
        else:
            for cp in range(start, end + 1):
                addr = ro_base + 2 * i + offsets[i] + 2 * (cp - start)
                glyph = struct.unpack(">H", data[addr:addr + 2])[0] if addr + 2 <= len(data) else 0
                if glyph and (glyph + deltas[i]) & 0xFFFF:
                    out.append((cp, cp))
    return out


def _merge(ranges) -> list[list[int]]:
    out: list[list[int]] = []
    for lo, hi in sorted(ranges):
        if out and lo <= out[-1][1] + 1:
            out[-1][1] = max(out[-1][1], hi)
        else:
            out.append([lo, hi])
    return out


def coverage_table(lock: dict, dest: str) -> dict:
    """The coverage.json content for the pinned fonts in `dest`."""
    fonts = {}
    ranges: list[tuple[int, int]] = []
    for pkg in lock["packages"]:
        for entry in pkg["files"]:
            name = _dest_name(entry)
            fonts[name] = _expected_hash(entry)
            ranges.extend(cmap_ranges(os.path.join(dest, name)))
    return {
        "schema": 1,
        "generated_by": "scripts/fetch_fonts.py",
        "fonts": dict(sorted(fonts.items())),
        "ranges": _merge(ranges),
    }


def _coverage_json(table: dict) -> str:
    # One range per line keeps diffs readable when a font is bumped.
    head = {k: v for k, v in table.items() if k != "ranges"}
    text = json.dumps(head, indent=2)[:-2]
    lines = ",\n".join(f"    [{lo}, {hi}]" for lo, hi in table["ranges"])
    return f'{text},\n  "ranges": [\n{lines}\n  ]\n}}\n'


def write_coverage(lock: dict, dest: str) -> bool:
    """(Re)write coverage.json when it differs. Returns True if written."""
    text = _coverage_json(coverage_table(lock, dest))
    path = os.path.join(dest, COVERAGE_FILENAME)
    try:
        with open(path, encoding="utf-8") as f:
            if f.read() == text:
                return False
    except OSError:
        pass
    _write_atomic(path, text.encode("utf-8"))
    return True


def _dest_name(entry: dict) -> str:
    name = entry.get("dest") or os.path.basename(entry["path"])
    if not name or name.startswith(".") or "/" in name or "\\" in name:
        raise FetchError(f"bad destination name {name!r}")
    return name


def _expected_hash(entry: dict) -> str:
    return entry.get("output_sha256") or entry["sha256"]


def _file_ok(path: str, sha256: str) -> bool:
    try:
        with open(path, "rb") as f:
            return _sha256(f.read()) == sha256
    except OSError:
        return False


def _write_atomic(path: str, data: bytes) -> None:
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".fetch-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _tarball(pkg: dict, registry: str, cache_dir: str | None) -> bytes:
    cached = None
    if cache_dir:
        safe = pkg["name"].replace("@", "").replace("/", "__")
        cached = os.path.join(cache_dir, f"{safe}-{pkg['version']}.tgz")
        if os.path.exists(cached):
            with open(cached, "rb") as f:
                data = f.read()
            try:
                _check_integrity(data, pkg["integrity"])
                return data
            except FetchError:
                pass  # stale or corrupt cache entry: fetch again
    data = _download(_tarball_url(registry, pkg["name"], pkg["version"]))
    _check_integrity(data, pkg["integrity"])
    if cached:
        os.makedirs(cache_dir, exist_ok=True)
        _write_atomic(cached, data)
    return data


def fetch(lock: dict, dest: str, cache_dir: str | None = None, log=print) -> int:
    """Fetch every missing or stale font. Returns the number of files written."""
    registry = lock.get("registry", "https://registry.npmjs.org")
    os.makedirs(dest, exist_ok=True)
    written = 0
    for pkg in lock["packages"]:
        todo = [e for e in pkg["files"] if not _file_ok(os.path.join(dest, _dest_name(e)), _expected_hash(e))]
        if not todo:
            continue
        log(f"fetch {pkg['name']}@{pkg['version']} ({len(todo)} file(s))")
        data = _tarball(pkg, registry, cache_dir)
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
            for entry in todo:
                try:
                    member = tf.getmember(entry["path"])
                except KeyError:
                    raise FetchError(f"{pkg['name']}: missing member {entry['path']}") from None
                if not member.isreg() or member.size > MAX_MEMBER_BYTES:
                    raise FetchError(f"{pkg['name']}: {entry['path']} is not a regular file of sane size")
                blob = tf.extractfile(member).read()
                if _sha256(blob) != entry["sha256"]:
                    raise FetchError(f"{pkg['name']}: sha256 mismatch for {entry['path']}")
                if entry.get("drop_tables"):
                    blob = drop_sfnt_tables(blob, set(entry["drop_tables"]))
                    if _sha256(blob) != entry["output_sha256"]:
                        raise FetchError(f"{pkg['name']}: rewritten {entry['path']} does not match output_sha256")
                _write_atomic(os.path.join(dest, _dest_name(entry)), blob)
                written += 1
    return written


def check(lock: dict, dest: str, log=print) -> list[str]:
    """Names of pinned fonts that are missing or differ from the lock."""
    bad = []
    for pkg in lock["packages"]:
        for entry in pkg["files"]:
            name = _dest_name(entry)
            if not _file_ok(os.path.join(dest, name), _expected_hash(entry)):
                bad.append(name)
    for name in bad:
        log(f"missing or modified: {name}")
    return bad


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--dest", default=DEFAULT_DEST, help="font directory (default: graph_tools/fonts)")
    ap.add_argument("--lock", default=None, help="lock file (default: <dest>/fonts.lock.json)")
    ap.add_argument("--cache-dir", default=None, help="keep verified tarballs here between runs")
    ap.add_argument("--check", action="store_true", help="verify the fonts in --dest, no network")
    args = ap.parse_args(argv)
    lock_path = args.lock or os.path.join(args.dest, "fonts.lock.json")
    with open(lock_path, encoding="utf-8") as f:
        lock = json.load(f)
    if lock.get("schema") != 1:
        print("fetch_fonts: unsupported lock schema", file=sys.stderr)
        return 2
    try:
        if args.check:
            bad = check(lock, args.dest)
            if not bad:
                expected = _coverage_json(coverage_table(lock, args.dest))
                try:
                    with open(os.path.join(args.dest, COVERAGE_FILENAME), encoding="utf-8") as f:
                        stale = f.read() != expected
                except OSError:
                    stale = True
                if stale:
                    bad.append(COVERAGE_FILENAME)
                    print(f"stale or missing: {COVERAGE_FILENAME} (run scripts/fetch_fonts.py)")
            print(f"fetch_fonts: {'OK' if not bad else f'{len(bad)} file(s) missing or modified'}")
            return 1 if bad else 0
        written = fetch(lock, args.dest, args.cache_dir)
        bad = check(lock, args.dest)
        if not bad and write_coverage(lock, args.dest):
            print(f"fetch_fonts: wrote {COVERAGE_FILENAME}")
    except FetchError as exc:
        print(f"fetch_fonts: {exc}", file=sys.stderr)
        return 1
    print(f"fetch_fonts: {written} file(s) written, {'all fonts verified' if not bad else 'verification FAILED'}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
