"""Render Markdown to PDF with Typst 0.15 (plan 5.1; locale 6.1; branding 6.2).

Pipeline
--------
1. `pdf_markdown.parse()` builds the token tree (TREE_VERSION 1).
2. `_Builder` turns it into the render tree that `pdf_template.typ` walks:
   per-block text direction, emoji runs, long tokens split into boxes,
   table column widths, checked math, validated images, footnotes, heading
   anchors and the allowed links.
3. `typst.compile()` runs the fixed template with the render tree and the
   page/language/branding settings as JSON in `sys.inputs`, inside a fresh,
   empty per-render root, with `ignore_system_fonts=True`, the bundled fonts
   (graph_tools/fonts), the vendored package directory (graph_tools/
   typst_packages, holding preview/mitex/0.2.7) and an empty read-only package
   cache, so nothing is ever downloaded. User text never becomes Typst source.

Importing this module is cheap and loads neither typst, PIL nor any font:
the server process can call `fonts_cover()` / `uncovered_characters()`,
which read the precomputed codepoint table graph_tools/fonts/coverage.json
(written by scripts/fetch_fonts.py). Rendering imports typst and PIL lazily.

Nothing here logs, and no warning, error or statistic carries document text:
`TypstRenderResult.warnings` maps a kind to a count.

Math: each distinct equation goes through a small mitex compile first (all
equations at once, bisected on failure, cached per process); one that fails,
or one the safety filter rejects, prints as its TeX source in a code span,
so '\\foo' never fails the document. cases/aligned environments get an
explicit \\quad gap at their column separators (Typst has none there).
"""
from __future__ import annotations

import base64
import binascii
import bisect
import io
import json
import os
import re
import shutil
import struct
import tempfile
import threading
import unicodedata
from dataclasses import dataclass, field
from typing import Any

from graph_tools.tools import pdf_markdown

__all__ = [
    "DEFAULT_FONT_DIR",
    "DEFAULT_PACKAGE_DIR",
    "TypstRenderError",
    "TypstRenderOptions",
    "TypstRenderResult",
    "bundled_script_coverage",
    "fonts_cover",
    "render_markdown_typst",
    "selftest",
    "uncovered_characters",
]

_HERE = os.path.dirname(os.path.abspath(__file__))
_GRAPH_TOOLS_DIR = os.path.dirname(_HERE)
DEFAULT_FONT_DIR = os.path.join(_GRAPH_TOOLS_DIR, "fonts")
DEFAULT_PACKAGE_DIR = os.path.join(_GRAPH_TOOLS_DIR, "typst_packages")
TEMPLATE_PATH = os.path.join(_HERE, "pdf_template.typ")
COVERAGE_FILENAME = "coverage.json"

# Caps (per render). Images beyond them print as '[image: alt]'.
MAX_IMAGES = 40
MAX_IMAGE_BYTES = 5 * 1024 * 1024          # decoded bytes, per image
MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024
MAX_IMAGE_PIXELS = 12_000_000              # per image (Typst decodes to RGBA)
MAX_TOTAL_IMAGE_PIXELS = 24_000_000
MAX_LOGO_BYTES = 2 * 1024 * 1024
MAX_LOGO_PIXELS = 4_000_000
MAX_TEX_CHARS = 3000                       # longer equations print as TeX
MAX_EQUATIONS = 400                        # distinct equations typeset per document
MAX_HREF_CHARS = 2048


class TypstRenderError(RuntimeError):
    """Rendering failed. The message never contains document text."""


@dataclass
class TypstRenderOptions:
    page_size: str | None = None       # 'A4' | 'Letter' | 'Legal'; None -> Letter for US/CA (6.1), else A4
    orientation: str = "portrait"      # 'portrait' | 'landscape'
    locale: str | None = None          # BCP-47, e.g. 'de-DE': footer language, default page size, /Lang
    branding: dict | None = None       # {'company_name', 'accent_color' '#RRGGBB', 'footer_text',
                                       #  'logo': bytes | None (PNG/JPEG)}
    font_dir: str | None = None        # default: graph_tools/fonts
    package_dir: str | None = None     # default: graph_tools/typst_packages (package ROOT)
    package_cache_dir: str | None = None  # an empty read-only directory; default: a fresh one per render


@dataclass
class TypstRenderResult:
    pdf: bytes
    pages: int
    missing_glyphs: int = 0            # distinct characters no bundled font covers
    math_fallbacks: int = 0            # equations printed as TeX source
    images_dropped: int = 0            # images printed as '[image: alt]'
    warnings: dict = field(default_factory=dict)   # kind -> count, content-free


# ---------------------------------------------------------------------------
# Font coverage (stdlib cmap reader; no typst, no full font load)
# ---------------------------------------------------------------------------

_FONT_EXTENSIONS = (".ttf", ".otf")
_coverage_lock = threading.Lock()
_coverage_cache: dict[str, tuple[list[int], list[int]] | None] = {}


def _cmap_ranges(path: str) -> list[tuple[int, int]]:
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
            return _cmap_format12(data, off)
    for key in ((3, 1), (0, 3), (0, 2), (0, 1), (0, 0)):
        off = subtables.get(key)
        if off is not None:
            if fmt(off) == 4:
                return _cmap_format4(data, off)
            if fmt(off) == 12:
                return _cmap_format12(data, off)
    return []


def _cmap_format12(data: bytes, off: int) -> list[tuple[int, int]]:
    n_groups = struct.unpack(">I", data[off + 12:off + 16])[0]
    out = []
    for start, end, glyph in struct.iter_unpack(">III", data[off + 16:off + 16 + 12 * n_groups]):
        if glyph == 0:
            start += 1  # the first code point of this group maps to .notdef
        if start <= end:
            out.append((start, end))
    return out


def _cmap_format4(data: bytes, off: int) -> list[tuple[int, int]]:
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
            # glyph = (cp + delta) mod 65536: at most one code point maps to .notdef
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


def _merge_ranges(ranges) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for lo, hi in sorted(ranges):
        if out and lo <= out[-1][1] + 1:
            if hi > out[-1][1]:
                out[-1] = (out[-1][0], hi)
        else:
            out.append((lo, hi))
    return out


def _font_files(font_dir: str) -> list[str]:
    try:
        names = sorted(os.listdir(font_dir))
    except OSError:
        return []
    return [os.path.join(font_dir, n) for n in names
            if n.lower().endswith(_FONT_EXTENSIONS) and not n.startswith(".")]


def compute_coverage(font_dir: str) -> list[tuple[int, int]]:
    """Merged code point ranges covered by any font file in `font_dir`."""
    ranges: list[tuple[int, int]] = []
    for path in _font_files(font_dir):
        try:
            ranges.extend(_cmap_ranges(path))
        except (OSError, struct.error):
            continue
    return _merge_ranges(ranges)


def _load_coverage(font_dir: str | None) -> tuple[list[int], list[int]] | None:
    """Coverage table for a font directory, cached per process.

    graph_tools/fonts/coverage.json (written by scripts/fetch_fonts.py) is
    used when it lists exactly the font files present, or when the fonts are
    not installed in this process's environment; otherwise the cmaps are read
    once. No font is loaded when coverage.json is valid."""
    key = os.path.abspath(font_dir or DEFAULT_FONT_DIR)
    with _coverage_lock:
        if key in _coverage_cache:
            return _coverage_cache[key]
        files = _font_files(key)
        ranges = None
        try:
            with open(os.path.join(key, COVERAGE_FILENAME), encoding="utf-8") as f:
                table = json.load(f)
            names = {os.path.basename(p) for p in files}
            if table.get("schema") == 1 and (not names or names == set(table.get("fonts", {}))):
                ranges = [(int(lo), int(hi)) for lo, hi in table["ranges"]]
        except (OSError, ValueError, KeyError, TypeError):
            ranges = None
        if ranges is None and files:
            ranges = compute_coverage(key)
        cov = ([lo for lo, _ in ranges], [hi for _, hi in ranges]) if ranges else None
        _coverage_cache[key] = cov
        return cov


def _covered(cov: tuple[list[int], list[int]] | None, cp: int) -> bool:
    if cov is None:
        return False
    i = bisect.bisect_right(cov[0], cp) - 1
    return i >= 0 and cp <= cov[1][i]


def _glyph_irrelevant(ch: str) -> bool:
    """Characters that need no glyph: controls, format characters (ZWJ,
    bidi marks, soft hyphen), spaces and variation selectors."""
    cp = ord(ch)
    if 0xFE00 <= cp <= 0xFE0F or 0xE0100 <= cp <= 0xE01EF:
        return True
    return unicodedata.category(ch) in ("Cc", "Cf", "Zs", "Zl", "Zp")


def uncovered_characters(text: str, font_dir: str | None = None) -> set[str]:
    """Characters of `text` that no bundled font covers (cmap check).

    Typst draws such characters as empty boxes without warning, so the
    renderer counts them as missing_glyph. Cheap: reads coverage.json once."""
    cov = _load_coverage(font_dir)
    return {ch for ch in set(text) if not _glyph_irrelevant(ch) and not _covered(cov, ord(ch))}


def fonts_cover(chars, font_dir: str | None = None) -> bool:
    """True when every character in `chars` (an iterable of characters or
    strings) has a glyph in a bundled font. Cheap enough for the server
    process: no typst import, and no font file is read when coverage.json is
    present."""
    cov = _load_coverage(font_dir)
    for ch in chars:
        for c in ch:
            if not _glyph_irrelevant(c) and not _covered(cov, ord(c)):
                return False
    return True


def _script_name(ch: str) -> str:
    try:
        name = unicodedata.name(ch)
    except ValueError:
        return "Other"
    if name.startswith("CJK ") or name.startswith("IDEOGRAPHIC"):
        return "Han"
    if name.startswith(("HIRAGANA", "KATAKANA", "HALFWIDTH KATAKANA")):
        return "Kana"
    if name.startswith("HANGUL"):
        return "Hangul"
    word = name.split(" ", 1)[0]
    return word.capitalize() if word.isalpha() else "Other"


def bundled_script_coverage(text: str, font_dir: str | None = None) -> dict:
    """Scripts of the letters, marks and digits in `text`, split by whether a
    bundled font covers every such character: {"covered": [...], "uncovered":
    [...]} (sorted script names such as 'Arabic', 'Devanagari', 'Han').
    "every unsupported script has a bundled font" == not result["uncovered"]."""
    cov = _load_coverage(font_dir)
    covered, uncovered = set(), set()
    last = "Other"
    for ch in set(text) if len(text) > 4096 else text:
        cat = unicodedata.category(ch)
        if cat[0] not in "LMN":
            continue
        script = _script_name(ch) if cat[0] != "M" else last
        if cat[0] != "M":
            last = script
        (covered if _covered(cov, ord(ch)) else uncovered).add(script)
    return {"covered": sorted(covered - uncovered), "uncovered": sorted(uncovered)}


# ---------------------------------------------------------------------------
# Locale, language, page size and footer (6.1)
# ---------------------------------------------------------------------------

_PAPERS = {  # width, height in pt, Typst paper name
    "A4": (595.2756, 841.8898, "a4"),
    "Letter": (612.0, 792.0, "us-letter"),
    "Legal": (612.0, 1008.0, "us-legal"),
}
_MARGIN_X = 51.0236        # 1.8cm (pdf_template.typ)
_MARGIN_Y = 56.6929 + 62.3622  # 2cm top + 2.2cm bottom
# CLDR supplemental paper-size data: regions that default to US Letter.
_LETTER_REGIONS = {"US", "CA", "MX", "PH", "CL", "CO", "CR", "GT", "NI", "PA", "PR", "SV", "VE", "BZ"}
_RTL_LANGS = {"ar", "he", "fa", "ur", "yi", "ps", "sd", "ug", "dv", "ckb", "iw"}
_FOOTERS = {
    "en": "Page {page} of {total}",
    "de": "Seite {page} von {total}",
    "fr": "Page {page} sur {total}",
    "es": "Página {page} de {total}",
    "it": "Pagina {page} di {total}",
    "pt": "Página {page} de {total}",
    "nl": "Pagina {page} van {total}",
    "pl": "Strona {page} z {total}",
    "tr": "Sayfa {page} / {total}",
    "ru": "Страница {page} из {total}",
    "uk": "Сторінка {page} з {total}",
    "ar": "صفحة {page} من {total}",
    "he": "עמוד {page} מתוך {total}",
    "hi": "पृष्ठ {page} / {total}",
    "bn": "পৃষ্ঠা {page} / {total}",
    "zh": "第 {page} 页，共 {total} 页",
    "zh-Hant": "第 {page} 頁，共 {total} 頁",
    "ja": "{page} / {total} ページ",
    "ko": "{total}페이지 중 {page}페이지",
    "th": "หน้า {page} จาก {total}",
    "sv": "Sida {page} av {total}",
    "da": "Side {page} af {total}",
    "nb": "Side {page} av {total}",
    "no": "Side {page} av {total}",
    "nn": "Side {page} av {total}",
    "fi": "Sivu {page} / {total}",
    "cs": "Strana {page} z {total}",
    "sk": "Strana {page} z {total}",
    "hu": "{page}. oldal / {total}",
    "ro": "Pagina {page} din {total}",
    "el": "Σελίδα {page} από {total}",
    "bg": "Страница {page} от {total}",
    "hr": "Stranica {page} od {total}",
    "sl": "Stran {page} od {total}",
    "lt": "Puslapis {page} iš {total}",
    "lv": "Lapa {page} no {total}",
    "et": "Lehekülg {page} / {total}",
    "ca": "Pàgina {page} de {total}",
    "vi": "Trang {page} / {total}",
    "id": "Halaman {page} dari {total}",
    "ms": "Halaman {page} daripada {total}",
    "fa": "صفحه {page} از {total}",
    "ur": "صفحہ {page} از {total}",
    "mr": "पृष्ठ {page} / {total}",
    "ta": "பக்கம் {page} / {total}",
    "te": "పేజీ {page} / {total}",
    "kn": "ಪುಟ {page} / {total}",
    "ml": "പേജ് {page} / {total}",
    "gu": "પૃષ્ઠ {page} / {total}",
    "pa": "ਪੰਨਾ {page} / {total}",
}
_LOCALE_RE = re.compile(r"^([A-Za-z]{2,3})(?:[-_]([A-Za-z]{4}))?(?:[-_]([A-Za-z]{2}|\d{3}))?(?:[-_][A-Za-z0-9-]*)?$")
# Script groups (detection) -> default language, and language -> script group.
_SCRIPT_LANG = {
    "arabic": "ar", "hebrew": "he", "devanagari": "hi", "bengali": "bn", "gurmukhi": "pa",
    "gujarati": "gu", "oriya": "or", "tamil": "ta", "telugu": "te", "kannada": "kn",
    "malayalam": "ml", "thai": "th", "han": "zh", "kana": "ja", "hangul": "ko",
    "greek": "el", "cyrillic": "ru", "latin": "en",
}
_LANG_SCRIPT = {
    "ar": "arabic", "fa": "arabic", "ur": "arabic", "ps": "arabic", "sd": "arabic", "ug": "arabic",
    "ckb": "arabic", "he": "hebrew", "iw": "hebrew", "yi": "hebrew", "hi": "devanagari",
    "mr": "devanagari", "ne": "devanagari", "sa": "devanagari", "bn": "bengali", "as": "bengali",
    "pa": "gurmukhi", "gu": "gujarati", "or": "oriya", "ta": "tamil", "te": "telugu",
    "kn": "kannada", "ml": "malayalam", "th": "thai", "zh": "han", "ja": "kana", "ko": "hangul",
    "el": "greek", "ru": "cyrillic", "uk": "cyrillic", "bg": "cyrillic", "sr": "cyrillic",
    "mk": "cyrillic", "be": "cyrillic", "kk": "cyrillic", "ky": "cyrillic", "mn": "cyrillic",
}
_SCRIPT_RANGES = (  # (start, end, group), sorted; letters only are counted
    (0x0041, 0x024F, "latin"), (0x0370, 0x03FF, "greek"), (0x0400, 0x052F, "cyrillic"),
    (0x0590, 0x05FF, "hebrew"), (0x0600, 0x06FF, "arabic"), (0x0750, 0x077F, "arabic"),
    (0x08A0, 0x08FF, "arabic"), (0x0900, 0x097F, "devanagari"), (0x0980, 0x09FF, "bengali"),
    (0x0A00, 0x0A7F, "gurmukhi"), (0x0A80, 0x0AFF, "gujarati"), (0x0B00, 0x0B7F, "oriya"),
    (0x0B80, 0x0BFF, "tamil"), (0x0C00, 0x0C7F, "telugu"), (0x0C80, 0x0CFF, "kannada"),
    (0x0D00, 0x0D7F, "malayalam"), (0x0E00, 0x0E7F, "thai"), (0x1100, 0x11FF, "hangul"),
    (0x1E00, 0x1EFF, "latin"), (0x1F00, 0x1FFF, "greek"), (0x3040, 0x30FF, "kana"),
    (0x3130, 0x318F, "hangul"), (0x31F0, 0x31FF, "kana"), (0x3400, 0x4DBF, "han"),
    (0x4E00, 0x9FFF, "han"), (0xAC00, 0xD7AF, "hangul"), (0xF900, 0xFAFF, "han"),
    (0xFB1D, 0xFB4F, "hebrew"), (0xFB50, 0xFDFF, "arabic"), (0xFE70, 0xFEFF, "arabic"),
    (0xFF66, 0xFF9F, "kana"), (0x20000, 0x2FFFF, "han"),
)
_SCRIPT_STARTS = [r[0] for r in _SCRIPT_RANGES]


def _script_group(cp: int) -> str | None:
    i = bisect.bisect_right(_SCRIPT_STARTS, cp) - 1
    if i >= 0 and cp <= _SCRIPT_RANGES[i][1]:
        return _SCRIPT_RANGES[i][2]
    return None


def _parse_locale(locale: str | None) -> tuple[str | None, str | None, str | None]:
    if not locale or not isinstance(locale, str):
        return None, None, None
    m = _LOCALE_RE.match(locale.strip())
    if not m:
        return None, None, None
    lang = m.group(1).lower()
    script = m.group(2).title() if m.group(2) else None
    region = m.group(3).upper() if m.group(3) and m.group(3).isalpha() else None
    return lang, script, region


def _script_counts(text: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for ch in text:
        cp = ord(ch)
        if cp < 0x41 or not ch.isalpha():
            continue
        group = _script_group(cp)
        if group:
            counts[group] = counts.get(group, 0) + 1
    return counts


def _footer_parts(pattern: str) -> list[str]:
    return [p for p in re.split(r"(\{page\}|\{total\})", pattern) if p]


# ---------------------------------------------------------------------------
# Text helpers: direction, emoji, width estimates, long-token chunks
# ---------------------------------------------------------------------------

def _first_strong(text: str) -> str | None:
    for ch in text:
        if ch.isascii() and not ch.isalpha():
            continue
        bidi = unicodedata.bidirectional(ch)
        if bidi == "L":
            return "ltr"
        if bidi in ("R", "AL"):
            return "rtl"
    return None


def _inline_first_strong(nodes) -> str | None:
    """First strong direction in token-tree inline nodes (code and math skipped)."""
    for n in nodes:
        t = n.get("type")
        if t == "text":
            d = _first_strong(n["value"])
        elif t == "autolink":
            d = _first_strong(n.get("value", ""))
        elif t == "image":
            d = _first_strong(n.get("alt", ""))
        elif "children" in n and t not in ("code_inline", "math_inline"):
            d = _inline_first_strong(n["children"])
        else:
            d = None
        if d:
            return d
    return None


def _blocks_first_strong(nodes) -> str | None:
    for n in nodes:
        t = n.get("type")
        if t in ("paragraph", "heading"):
            d = _inline_first_strong(n.get("children", []))
        elif t == "table":
            d = None
            for c in n.get("header", []):
                d = d or _inline_first_strong(c)
            for row in n.get("rows", [])[:20]:
                for c in row:
                    d = d or _inline_first_strong(c)
        elif t in ("bullet_list", "ordered_list", "list_item", "blockquote"):
            d = _blocks_first_strong(n.get("children", []))
        elif t == "deflist":
            d = None
            for item in n.get("children", []):
                d = d or _inline_first_strong(item.get("term", []))
        else:
            d = None
        if d:
            return d
    return None


# Emoji_Presentation=Yes code points below U+1F000 (Unicode emoji-data.txt).
_EMOJI_BMP = frozenset(
    [0x231A, 0x231B, 0x23E9, 0x23EA, 0x23EB, 0x23EC, 0x23F0, 0x23F3, 0x25FD, 0x25FE, 0x2614, 0x2615,
     *range(0x2648, 0x2654), 0x267F, 0x2693, 0x26A1, 0x26AA, 0x26AB, 0x26BD, 0x26BE, 0x26C4, 0x26C5,
     0x26CE, 0x26D4, 0x26EA, 0x26F2, 0x26F3, 0x26F5, 0x26FA, 0x26FD, 0x2705, 0x270A, 0x270B, 0x2728,
     0x274C, 0x274E, 0x2753, 0x2754, 0x2755, 0x2757, 0x2795, 0x2796, 0x2797, 0x27B0, 0x27BF, 0x2B1B,
     0x2B1C, 0x2B50, 0x2B55])


def _emoji_presentation(cp: int) -> bool:
    if cp in _EMOJI_BMP:
        return True
    if 0x1F000 <= cp <= 0x1FAFF:
        if 0x1F100 <= cp <= 0x1F1E5:
            return cp == 0x1F18E or 0x1F191 <= cp <= 0x1F19A
        return True
    return False


def _emoji_capable(cp: int) -> bool:
    """May turn into an emoji with U+FE0F (©️, ⚠️, ❤️, ...)."""
    return (cp in (0xA9, 0xAE, 0x203C, 0x2049, 0x3030, 0x303D, 0x3297, 0x3299)
            or 0x2100 <= cp <= 0x2BFF or 0x1F000 <= cp <= 0x1FAFF)


def _emoji_modifiers(s: str, k: int) -> int:
    n = len(s)
    while k < n:
        c = ord(s[k])
        if c == 0xFE0F or 0x1F3FB <= c <= 0x1F3FF or 0xE0020 <= c <= 0xE007F or c == 0x20E3:
            k += 1
        else:
            break
    return k


def _emoji_end(s: str, i: int) -> int:
    """End of an emoji sequence starting at s[i], or -1."""
    n = len(s)
    cp = ord(s[i])
    nxt = ord(s[i + 1]) if i + 1 < n else 0
    if nxt == 0xFE0E:
        return -1  # explicit text presentation
    if 0x1F1E6 <= cp <= 0x1F1FF:
        return i + 2 if 0x1F1E6 <= nxt <= 0x1F1FF else i + 1
    if s[i] in "0123456789#*":
        k = i + 1
        if k < n and s[k] == "\ufe0f":
            k += 1
        return k + 1 if k < n and s[k] == "\u20e3" else -1
    if not (_emoji_presentation(cp) or (nxt == 0xFE0F and _emoji_capable(cp))):
        return -1
    k = _emoji_modifiers(s, i + 1)
    while k + 1 < n and s[k] == "\u200d":
        c2 = ord(s[k + 1])
        if not (_emoji_presentation(c2) or _emoji_capable(c2)):
            break
        k = _emoji_modifiers(s, k + 2)
    return k


def _split_emoji(s: str) -> list:
    """Split a string into text and {'t': 'emoji'} runs (drawn with the colour font)."""
    if not any(ord(c) >= 0x2100 or c == "\u20e3" for c in s):
        return [s]
    out: list = []
    buf_start = 0
    i, n = 0, len(s)
    while i < n:
        cp = ord(s[i])
        if cp >= 0x2100 or s[i] in "0123456789#*" or cp in (0xA9, 0xAE, 0x203C, 0x2049):
            j = _emoji_end(s, i)
            if j > i:
                if buf_start < i:
                    out.append(s[buf_start:i])
                out.append({"t": "emoji", "v": s[i:j]})
                i = buf_start = j
                continue
        i += 1
    if buf_start < n:
        out.append(s[buf_start:])
    return out


# Advance widths of ASCII 32..126 in em (Noto Sans Bold; regular is narrower).
_ASCII_EM = (
    0.26, 0.282, 0.479, 0.646, 0.572, 0.902, 0.75, 0.266, 0.339, 0.339, 0.542, 0.572, 0.285, 0.32,
    0.281, 0.415, 0.572, 0.572, 0.572, 0.572, 0.572, 0.572, 0.572, 0.572, 0.572, 0.572, 0.281, 0.285,
    0.572, 0.572, 0.572, 0.477, 0.898, 0.692, 0.665, 0.642, 0.732, 0.56, 0.549, 0.724, 0.765, 0.389,
    0.331, 0.664, 0.559, 0.943, 0.813, 0.791, 0.621, 0.791, 0.656, 0.551, 0.577, 0.756, 0.65, 0.967,
    0.67, 0.626, 0.579, 0.331, 0.415, 0.331, 0.572, 0.411, 0.365, 0.599, 0.632, 0.516, 0.632, 0.597,
    0.387, 0.632, 0.65, 0.299, 0.298, 0.62, 0.298, 0.975, 0.65, 0.625, 0.632, 0.632, 0.447, 0.502,
    0.434, 0.65, 0.571, 0.856, 0.578, 0.571, 0.493, 0.394, 0.551, 0.394, 0.572,
)
_EM_CACHE: dict[str, float] = {chr(32 + i): w for i, w in enumerate(_ASCII_EM)}


def _char_em(ch: str) -> float:
    w = _EM_CACHE.get(ch)
    if w is None:
        cp = ord(ch)
        if cp < 32:
            w = 0.0
        elif unicodedata.east_asian_width(ch) in ("W", "F"):
            w = 1.0
        elif unicodedata.category(ch) in ("Mn", "Me", "Cf"):
            w = 0.0
        else:
            w = 0.62
        if len(_EM_CACHE) < 20000:
            _EM_CACHE[ch] = w
    return w


def _text_em(s: str) -> float:
    return sum(map(_char_em, s))


def _breakable(ch: str) -> bool:
    """Characters around which a line can break (spaces, CJK, Thai-family)."""
    if ch.isspace():
        return True
    cp = ord(ch)
    if cp < 0x0E00:
        return False
    if 0x0E00 <= cp <= 0x0EFF or 0x1000 <= cp <= 0x109F or 0x1780 <= cp <= 0x17FF:
        return True
    return unicodedata.east_asian_width(ch) in ("W", "F")


_SOFT_BREAK_AFTER = frozenset("/-_.,;:?&=+|\\)]}>@#")


def _chunk_run(run: str, max_em: float) -> list[str]:
    """Split an unbreakable run into pieces of at most max_em, preferring
    boundaries after '/', '-', '.', '?', '&', ... ."""
    pieces: list[str] = []
    cur: list[str] = []
    cur_em = 0.0
    last_soft = -1
    for ch in run:
        w = _char_em(ch)
        if cur and cur_em + w > max_em:
            if last_soft > 0:
                pieces.append("".join(cur[:last_soft]))
                cur = cur[last_soft:]
            else:
                pieces.append("".join(cur))
                cur = []
            cur_em = _text_em("".join(cur))
            last_soft = -1
        cur.append(ch)
        cur_em += w
        if ch in _SOFT_BREAK_AFTER:
            last_soft = len(cur)
    if cur:
        pieces.append("".join(cur))
    return pieces


def _long_runs(s: str, max_em: float) -> list[tuple[int, int]]:
    """(start, end) of runs without a break opportunity wider than max_em."""
    if len(s) <= max_em:  # no character is wider than 1em, so no run can exceed max_em
        return []
    out = []
    start = None
    width = 0.0
    for i, ch in enumerate(s):
        if _breakable(ch):
            if start is not None and width > max_em:
                out.append((start, i))
            start = None
            width = 0.0
        else:
            if start is None:
                start = i
            width += _char_em(ch)
    if start is not None and width > max_em:
        out.append((start, len(s)))
    return out


def _chunked(s: str, max_em: float, stats: dict) -> list:
    runs = _long_runs(s, max_em) if max_em else []
    if not runs:
        return [s]
    out: list = []
    pos = 0
    for a, b in runs:
        if pos < a:
            out.append(s[pos:a])
        out.append({"t": "chunks", "v": _chunk_run(s[a:b], max_em * 0.92)})
        pos = b
    if pos < len(s):
        out.append(s[pos:])
    stats["long_token_split"] = stats.get("long_token_split", 0) + len(runs)
    return out


def _normalize_title(text: str | None) -> str:
    return " ".join((text or "").split()).casefold()


def _ends_with_colon(node: dict) -> bool:
    content = node.get("c") or []
    last = content[-1] if content else None
    return isinstance(last, str) and last.rstrip().endswith((":", "：")) and len(content) <= 4


# ---------------------------------------------------------------------------
# Math: safety filter, column gaps, checks
# ---------------------------------------------------------------------------

_LENGTH_RE = re.compile(r"^\s*[-+]?(?:\d+(?:\.\d*)?|\.\d+)\s*(?:pt|em|ex|cm|mm|in|bp|pc|mu|sp|dd|cc)?\s*$")
_EVAL_COMMANDS = ("raisebox", "hspace", "vspace")
_GAP_ENVS = {
    "cases": "cases", "cases*": "cases", "dcases": "cases", "dcases*": "cases", "rcases": "cases",
    "aligned": "align", "align": "align", "align*": "align", "alignat": "align", "alignat*": "align",
    "alignedat": "align", "flalign": "align", "flalign*": "align", "split": "align",
}
_TEX_TOKEN_RE = re.compile(r"\\(begin|end)\s*\{([A-Za-z*]+)\}|\\\\|\\[&{}]|[{}&]")


def _braced_arg(tex: str, pos: int) -> str | None:
    """The {...} group starting at or after pos (spaces allowed), or None."""
    while pos < len(tex) and tex[pos] in " *":
        pos += 1
    if pos >= len(tex) or tex[pos] != "{":
        return None
    depth = 0
    for k in range(pos, len(tex)):
        c = tex[k]
        if c == "\\":
            continue
        if c == "{" and (k == 0 or tex[k - 1] != "\\"):
            depth += 1
        elif c == "}" and (k == 0 or tex[k - 1] != "\\"):
            depth -= 1
            if depth == 0:
                return tex[pos + 1:k]
    return None


def _tex_is_safe(tex: str) -> bool:
    """mitex evaluates the argument of \\raisebox, \\hspace and \\vspace as
    Typst code; allow those only with a plain TeX length. \\includegraphics is
    refused outright (it would try to load a file)."""
    if "\\includegraphics" in tex:
        return False
    for cmd in _EVAL_COMMANDS:
        for m in re.finditer(r"\\" + cmd + r"(?![A-Za-z])", tex):
            arg = _braced_arg(tex, m.end())
            if arg is None or not _LENGTH_RE.match(arg):
                return False
    return True


def _gap_environments(tex: str) -> str:
    """Give cases/aligned column separators the gap LaTeX has and Typst lacks:
    '&' -> '&\\quad ' in cases, every second '&' of a row in align-likes."""
    if "\\begin" not in tex:
        return tex
    out: list[str] = []
    pos = 0
    stack: list[list] = []  # [kind, brace depth at \begin, '&' count in the row]
    brace = 0
    for m in _TEX_TOKEN_RE.finditer(tex):
        tok = m.group(0)
        out.append(tex[pos:m.start()])
        pos = m.end()
        if m.group(1) == "begin":
            stack.append([_GAP_ENVS.get(m.group(2)), brace, 0])
        elif m.group(1) == "end":
            if stack:
                stack.pop()
        elif tok == "{":
            brace += 1
        elif tok == "}":
            brace -= 1
        elif tok == "\\\\":
            if stack:
                stack[-1][2] = 0
        elif tok == "&" and stack and stack[-1][0] and brace == stack[-1][1]:
            stack[-1][2] += 1
            if stack[-1][0] == "cases":
                tok = "&\\quad "
            elif stack[-1][2] % 2 == 0:
                tok = "&\\qquad "
        out.append(tok)
    out.append(tex[pos:])
    return "".join(out)


def _prepare_tex(tex: str) -> str | None:
    t = (tex or "").strip()
    if not t or len(t) > MAX_TEX_CHARS or not _tex_is_safe(t):
        return None
    return _gap_environments(t)


_math_cache: dict[str, bool] = {}
_MATH_CHECK_SRC = (
    b'#import "@preview/mitex:0.2.7": mitex\n'
    b'#for t in json(bytes(sys.inputs.m)) { mitex(t) }\n'
)


def _check_equations(texs: list[str], compile_kwargs: dict) -> dict[str, bool]:
    """mitex result per distinct equation: all in one compile, bisected on failure."""
    import typst

    results = {t: _math_cache[t] for t in texs if t in _math_cache}
    todo = [t for t in texs if t not in results]

    def compiles(group: list[str]) -> bool:
        try:
            typst.compile(_MATH_CHECK_SRC, format="pdf", sys_inputs={"m": json.dumps(group)}, **compile_kwargs)
            return True
        except Exception:  # TypstError (or a plugin error): fall back to raw TeX
            return False

    def solve(group: list[str]) -> None:
        if not group:
            return
        if compiles(group):
            for t in group:
                results[t] = True
        elif len(group) == 1:
            results[group[0]] = False
        else:
            mid = len(group) // 2
            solve(group[:mid])
            solve(group[mid:])

    solve(todo)
    if len(_math_cache) > 4096:
        _math_cache.clear()
    for t in todo:
        _math_cache[t] = results[t]
    return results


# ---------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------

_DATA_URI_RE = re.compile(r"^data:([A-Za-z0-9.+/-]*)((?:;[A-Za-z0-9=._+-]+)*?);base64,(.*)$", re.DOTALL | re.IGNORECASE)


def _decode_data_uri(src: str, max_bytes: int) -> bytes | None:
    m = _DATA_URI_RE.match(src.strip())
    if not m:
        return None
    payload = re.sub(r"\s+", "", m.group(3))
    if len(payload) > (max_bytes * 4) // 3 + 8:
        return None
    try:
        data = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError):
        return None
    return data if 0 < len(data) <= max_bytes else None


def _validate_image(data: bytes, max_pixels: int) -> tuple[bytes, str, int, int] | None:
    """(bytes, extension, width, height) of a PNG or JPEG Typst can embed, or None.

    PNG and baseline RGB/grey JPEG pass through unchanged after PIL checks
    the header, the pixel count and the file's integrity; GIF, WebP, BMP,
    TIFF and unusual JPEG modes are converted to PNG (first frame)."""
    from PIL import Image

    try:
        with Image.open(io.BytesIO(data)) as im:
            fmt, mode = im.format, im.mode
            width, height = im.size
            if width < 1 or height < 1 or width * height > max_pixels:
                return None
            im.verify()
    except Exception:
        return None
    if fmt == "PNG" or (fmt == "JPEG" and mode in ("L", "RGB")):
        return data, "png" if fmt == "PNG" else "jpg", width, height
    if fmt not in ("GIF", "WEBP", "BMP", "TIFF", "JPEG", "PPM"):
        return None
    try:
        with Image.open(io.BytesIO(data)) as im:
            im.seek(0)
            alpha = im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info)
            converted = im.convert("RGBA" if alpha else "RGB")
            buf = io.BytesIO()
            converted.save(buf, "PNG")
            return buf.getvalue(), "png", width, height
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Token tree -> render tree
# ---------------------------------------------------------------------------

_LANG_RE = re.compile(r"^[A-Za-z0-9_+#.-]{1,24}$")
_HEADING_EM_FACTOR = {1: 20 / 10.5, 2: 15 / 10.5, 3: 12 / 10.5, 4: 11 / 10.5}


class _Builder:
    def __init__(self, *, root: str, text_width: float, landscape_width: float | None,
                 text_height: float, doc_dir: str, heading_ids: set[str], footnotes: dict[int, dict]):
        self.root = root
        self.text_width = text_width
        self.landscape_width = landscape_width
        self.text_height = text_height
        self.doc_dir = doc_dir
        self.heading_ids = heading_ids
        self.footnotes = footnotes
        self.fn_seen: set[int] = set()
        self.math: list[tuple[dict, str | None, str]] = []  # (node, prepared tex, raw fallback)
        self.stats: dict[str, int] = {}
        self.images = 0
        self.image_bytes = 0
        self.image_pixels = 0
        self.images_dropped = 0
        self.line_em = text_width / 10.5

    def _count(self, kind: str, n: int = 1) -> None:
        self.stats[kind] = self.stats.get(kind, 0) + n

    def _dir(self, d: str | None) -> str | None:
        return d if d and d != self.doc_dir else None

    # -- inline -------------------------------------------------------------

    def inlines(self, nodes, max_em: float) -> list:
        out: list = []
        for n in nodes:
            t = n["type"]
            if t == "text":
                for part in _split_emoji(n["value"]):
                    if isinstance(part, str):
                        out.extend(_chunked(part, max_em, self.stats))
                    else:
                        out.append(part)
            elif t == "hardbreak":
                out.append({"t": "br"})
            elif t in ("strong", "em", "strike", "sub", "sup", "underline"):
                kind = {"strong": "b", "em": "i", "strike": "s", "sub": "sub", "sup": "sup", "underline": "u"}[t]
                out.append({"t": kind, "c": self.inlines(n["children"], max_em)})
            elif t == "code_inline":
                # Monospace at 0.9em is ~0.54em per character, close to the proportional estimate.
                value = n["value"]
                runs = _long_runs(value, max_em) if len(value) > 40 else []
                if runs:
                    pieces = []
                    pos = 0
                    for a, b in runs:
                        if pos < a:
                            pieces.append(value[pos:a])
                        pieces.extend(_chunk_run(value[a:b], max_em * 0.85))
                        pos = b
                    if pos < len(value):
                        pieces.append(value[pos:])
                    out.append({"t": "code", "v": pieces})
                    self._count("long_token_split")
                else:
                    out.append({"t": "code", "v": value})
            elif t == "math_inline":
                node = {"t": "math", "ok": False, "v": ""}
                self.math.append((node, _prepare_tex(n["tex"]), "\\(" + n["tex"] + "\\)"))
                out.append(node)
            elif t == "link":
                out.extend(self._link(n["href"], self.inlines(n["children"], max_em)))
            elif t == "autolink":
                body = self.inlines([{"type": "text", "value": n.get("value", "")}], max_em)
                out.extend(self._link(n["href"], body))
            elif t == "image":
                out.extend(self._image(n))
            elif t == "footnote_ref":
                out.append(self._footnote(n))
        # merge adjacent strings
        merged: list = []
        for x in out:
            if isinstance(x, str) and merged and isinstance(merged[-1], str):
                merged[-1] += x
            elif x != "":
                merged.append(x)
        return merged

    def _link(self, href: str, body: list) -> list:
        h = (href or "").strip()
        low = h.lower()
        if len(h) <= MAX_HREF_CHARS and low.startswith(("http://", "https://", "mailto:")) \
                and not any(ord(c) < 32 for c in h):
            return [{"t": "link", "href": h, "c": body}]
        if h.startswith("#") and h[1:] in self.heading_ids:
            return [{"t": "ref", "to": "md-" + h[1:], "c": body}]
        self._count("link_dropped")
        return body

    def _image(self, n: dict) -> list:
        alt = (n.get("alt") or "").strip()
        placeholder = f"[image: {alt}]" if alt else "[image]"
        src = n.get("src") or ""
        if not src.lower().startswith("data:") or self.images >= MAX_IMAGES:
            self.images_dropped += 1
            return [placeholder]
        data = _decode_data_uri(src, MAX_IMAGE_BYTES)
        checked = None
        if data is not None and self.image_bytes + len(data) <= MAX_TOTAL_IMAGE_BYTES:
            checked = _validate_image(data, MAX_IMAGE_PIXELS)
        if checked is None or self.image_pixels + checked[2] * checked[3] > MAX_TOTAL_IMAGE_PIXELS:
            self.images_dropped += 1
            return [placeholder]
        blob, ext, w_px, h_px = checked
        self.images += 1
        self.image_bytes += len(blob)
        self.image_pixels += w_px * h_px
        name = f"img-{self.images}.{ext}"
        with open(os.path.join(self.root, name), "wb") as f:
            f.write(blob)
        w_pt, h_pt = w_px * 0.75, h_px * 0.75  # 96 dpi
        max_h = 0.8 * self.text_height
        full = w_pt > 0.5 * self.text_width
        if full and self.text_width * h_px / w_px > max_h:
            full = False
            w_pt = max_h * w_px / h_px
        elif not full and h_pt > max_h:
            w_pt = max_h * w_px / h_px
        return [{"t": "img", "src": "/" + name, "alt": alt or None, "full": full, "w": round(w_pt, 2)}]

    def _footnote(self, n: dict) -> Any:
        fid = n.get("id", -1)
        definition = self.footnotes.get(fid)
        if definition is None:
            return f"[^{n.get('label') or ''}]"
        label = f"fn-{fid}"
        if fid in self.fn_seen:
            return {"t": "fn", "first": False, "label": label}
        self.fn_seen.add(fid)
        body = self.blocks(definition.get("children", []), item=True, max_em=self.line_em * 0.9)
        return {"t": "fn", "first": True, "label": label, "c": {"t": "li", "c": body}}

    # -- blocks -------------------------------------------------------------

    def blocks(self, nodes, *, item: bool = False, top: bool = False, max_em: float | None = None) -> list:
        max_em = max_em or self.line_em * 0.9
        out = []
        for n in nodes:
            node = self.block(n, item=item, top=top, max_em=max_em)
            if node is None:
                continue
            if node["t"] == "table" and node.get("landscape"):
                # Move the heading and/or 'Lead-in:' line that introduces a
                # landscape table onto its page instead of stranding it.
                lead: list = []
                if out and out[-1]["t"] == "p" and _ends_with_colon(out[-1]):
                    lead.insert(0, out.pop())
                if out and out[-1]["t"] == "h":
                    lead.insert(0, out.pop())
                if lead:
                    node["lead"] = lead
            out.append(node)
        return out

    def block(self, n: dict, *, item: bool, top: bool, max_em: float):
        t = n["type"]
        if t == "paragraph":
            d = self._dir(_inline_first_strong(n["children"]))
            node = {"t": "ip" if item else "p", "c": self.inlines(n["children"], max_em)}
            if d:
                node["dir"] = d
            return node
        if t == "heading":
            level = n.get("level", 1)
            em = max_em / _HEADING_EM_FACTOR.get(level, 1.0)
            node = {"t": "h", "level": level, "id": "md-" + n["id"] if n.get("id") else None,
                    "c": self.inlines(n["children"], em)}
            d = self._dir(_inline_first_strong(n["children"]))
            if d:
                node["dir"] = d
            return node
        if t in ("bullet_list", "ordered_list"):
            return self._list(n, max_em)
        if t == "blockquote":
            node = {"t": "quote", "c": self.blocks(n["children"], max_em=max_em - 1.5)}
            d = self._dir(_blocks_first_strong(n["children"]))
            if d:
                node["dir"] = d
            return node
        if t == "code_block":
            return self._code(n)
        if t == "math_block":
            node = {"t": "mathblock", "ok": False, "v": "", "eqno": n.get("eqno")}
            self.math.append((node, _prepare_tex(n["tex"]), "\\[" + n["tex"] + "\\]"))
            return node
        if t == "hr":
            return {"t": "hr"}
        if t == "table":
            return self._table(n, top=top, max_em=max_em)
        if t == "deflist":
            items = []
            for it in n.get("children", []):
                items.append({
                    "term": self.inlines(it.get("term", []), max_em),
                    "defs": [{"t": "li", "c": self.blocks(d, item=True, max_em=max_em - 1.6)}
                             for d in it.get("definitions", [])],
                })
            return {"t": "dl", "items": items}
        return None

    def _list(self, n: dict, max_em: float) -> dict:
        inner = max_em - 1.6
        items = []
        tasks = bool(n["children"]) and all(it.get("task") is not None for it in n["children"])
        for it in n["children"]:
            body = self.blocks(it.get("children", []), item=True, max_em=inner)
            if it.get("task") is not None:
                box = {"t": "task", "v": bool(it["task"])}
                if body and body[0]["t"] == "ip":
                    body[0]["c"].insert(0, box)
                else:
                    body.insert(0, {"t": "ip", "c": [box]})
            items.append({"t": "li", "c": body})
        node: dict = {"t": "ul" if n["type"] == "bullet_list" else "ol", "items": items,
                      "tight": bool(n.get("tight", True)), "tasks": tasks}
        if n["type"] == "ordered_list":
            node["start"] = max(0, int(n.get("start", 1)))
            node["numbering"] = "1)" if n.get("delimiter") == ")" else "1."
        d = self._dir(_blocks_first_strong(n["children"]))
        if d:
            node["dir"] = d
        return node

    def _code(self, n: dict) -> dict:
        value = n.get("value", "")
        lang = n.get("lang")
        lang = lang if lang and _LANG_RE.match(lang) else None
        max_chars = 80
        lines = value.split("\n")
        if not any(len(line) > max_chars and _long_runs(line, max_chars * 0.62) for line in lines):
            return {"t": "codeblock", "v": value, "lang": lang}
        # Some line holds a token without break opportunity: monospace lines with that token in boxes.
        out_lines = []
        for line in lines:
            runs = _long_runs(line, max_chars * 0.62) if len(line) > max_chars else []
            parts: list = []
            pos = 0
            for a, b in runs:
                if pos < a:
                    parts.append(line[pos:a])
                run = line[a:b]
                parts.append([run[k:k + max_chars] for k in range(0, len(run), max_chars)])
                pos = b
            if pos < len(line) or not parts:
                parts.append(line[pos:])
            out_lines.append(parts)
        self._count("long_token_split")
        return {"t": "pre", "lines": out_lines}

    def _table(self, n: dict, *, top: bool, max_em: float) -> dict:
        header = n.get("header", [])
        rows = n.get("rows", [])
        ncol = max(1, len(header))
        size = 10.5 if ncol <= 4 else 9.5 if ncol <= 6 else 8.5 if ncol <= 8 else 8.0
        inset = 6.0 if ncol <= 4 else 5.0 if ncol <= 6 else 4.0 if ncol <= 8 else 3.0
        inset_y = 4.0 if ncol <= 6 else 3.0
        # Natural (one-line) and minimum (longest unbreakable run) widths per column, in em.
        nat = [0.0] * ncol
        mins = [0.0] * ncol
        for r, row in enumerate([header] + rows):
            for c in range(ncol):
                cell = row[c] if c < len(row) else []
                text = pdf_markdown.plain_text(cell)
                if not text:
                    continue
                for line in text.split("\n"):
                    w = _text_em(line) * (1.05 if r == 0 else 1.0)
                    if w > nat[c]:
                        nat[c] = w
                    if w > mins[c]:
                        longest = 0.0
                        cur = 0.0
                        for ch in line:
                            if _breakable(ch):
                                longest = max(longest, cur)
                                cur = 0.0
                            else:
                                cur += _char_em(ch)
                        longest = max(longest, cur)
                        mins[c] = max(mins[c], min(longest, 12.0))
        pad = 2 * inset + 1.5
        nat_pt = [w * size + pad for w in nat]
        min_pt = [max(w, 2.0) * size + pad for w in mins]
        nested_shrink = 1.0 if top else 0.9
        width = self.text_width * nested_shrink
        landscape = False
        if top and self.landscape_width and ncol >= 6 and (
                sum(nat_pt) > 1.25 * width or sum(min_pt) > width):
            landscape = True
            width = self.landscape_width
            self._count("landscape_table")
        total_nat, total_min = sum(nat_pt), sum(min_pt)
        if total_nat <= width:
            cols = [w * width / total_nat for w in nat_pt] if total_nat > 0 else [width / ncol] * ncol
        elif total_min >= width:
            cols = [w * width / total_min for w in min_pt]
        else:
            share = (width - total_min) / (total_nat - total_min)
            cols = [m + (w - m) * share for w, m in zip(nat_pt, min_pt)]
        cell_em = [max(2.0, (w - 2 * inset - 1.5) / size) for w in cols]

        def cell(nodes, c):
            if len(nodes) == 1 and nodes[0]["type"] == "text":
                built = self.inlines(nodes, cell_em[c])
                if len(built) == 1 and isinstance(built[0], str):
                    return built[0]
                return built
            return self.inlines(nodes, cell_em[c])

        head = [cell(header[c] if c < len(header) else [], c) for c in range(ncol)]
        cells = [cell(row[c] if c < len(row) else [], c) for row in rows for c in range(ncol)]
        node = {"t": "table", "cols": [round(w, 2) for w in cols], "align": (n.get("align") or [None] * ncol)[:ncol],
                "size": size, "inset": inset, "inset_y": inset_y, "head": head, "cells": cells,
                "plain": all(isinstance(c, str) for c in cells), "landscape": landscape}
        node["align"] += [None] * (ncol - len(node["align"]))
        d = self._dir(_blocks_first_strong([n]))
        if d:
            node["dir"] = d
        return node


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

_template_cache: list[bytes] = []
_PAGES_RE = re.compile(rb"<<([^<>]*?/Type\s*/Pages\b[^<>]*?)>>")
_COUNT_RE = re.compile(rb"/Count\s+(\d+)")
_HEX_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")


def _template() -> bytes:
    if not _template_cache:
        with open(TEMPLATE_PATH, "rb") as f:
            _template_cache.append(f.read())
    return _template_cache[0]


def _count_pages(pdf: bytes) -> int:
    best = 0
    for m in _PAGES_RE.finditer(pdf):
        c = _COUNT_RE.search(m.group(1))
        if c:
            best = max(best, int(c.group(1)))
    if best:
        return best
    return len(re.findall(rb"/Type\s*/Page\b", pdf))


def _clean_text(value: Any, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    text = "".join(ch for ch in value if unicodedata.category(ch)[0] != "C" or ch == " ").strip()
    return text[:limit] or None


def _font_stack(cjk: list[str]) -> list[str]:
    return ["Noto Sans", "Noto Sans Arabic", "Noto Sans Hebrew", "Noto Sans Devanagari",
            "Noto Sans Bengali", "Noto Sans Gurmukhi", "Noto Sans Gujarati", "Noto Sans Oriya",
            "Noto Sans Tamil", "Noto Sans Telugu", "Noto Sans Kannada", "Noto Sans Malayalam",
            "Noto Sans Thai", "Noto Sans Math", "Noto Sans Symbols 2", *cjk, "Noto Color Emoji"]


def render_markdown_typst(markdown: str, title: str | None = None,
                          options: TypstRenderOptions | None = None) -> TypstRenderResult:
    """Render Markdown to a PDF with Typst. Raises TypstRenderError (content-free) on failure."""
    import typst

    opts = options or TypstRenderOptions()
    warnings: dict[str, int] = {}
    font_dir = os.path.abspath(opts.font_dir or DEFAULT_FONT_DIR)
    package_dir = os.path.abspath(opts.package_dir or DEFAULT_PACKAGE_DIR)
    title = _clean_text(title, 300)

    tree = pdf_markdown.parse(markdown or "")
    children = tree.get("children", [])

    # Language, direction, CJK order (6.1, plan 5.1)
    plain = pdf_markdown.plain_text(tree)
    sample = (title or "") + "\n" + plain
    counts = _script_counts(sample if len(sample) < 400_000 else sample[:400_000])
    loc_lang, loc_script, loc_region = _parse_locale(opts.locale)
    dominant = max(counts, key=lambda k: counts[k]) if counts else "latin"
    if counts.get("kana") and dominant == "han":
        dominant = "kana"
    if loc_lang and _LANG_SCRIPT.get(loc_lang, "latin") == dominant:
        lang = loc_lang
    elif loc_lang and dominant == "han" and loc_lang == "ja":
        lang = "ja"
    else:
        lang = _SCRIPT_LANG.get(dominant, "en")
    if not re.fullmatch(r"[a-z]{2,3}", lang):
        lang = "en"
    region = loc_region if loc_lang == lang else None
    kana, hangul = counts.get("kana", 0), counts.get("hangul", 0)
    if (kana and kana >= hangul) or loc_lang == "ja":
        cjk = ["Noto Sans JP", "Noto Sans SC", "Noto Sans KR"]
    elif hangul or loc_lang == "ko":
        cjk = ["Noto Sans KR", "Noto Sans JP", "Noto Sans SC"]
    else:
        cjk = ["Noto Sans SC", "Noto Sans JP", "Noto Sans KR"]
    doc_dir = _blocks_first_strong(children) or ("rtl" if lang in _RTL_LANGS else "ltr")

    # Page size and orientation (6.1)
    size_key = None
    if isinstance(opts.page_size, str):
        size_key = {"a4": "A4", "letter": "Letter", "us-letter": "Letter", "legal": "Legal",
                    "us-legal": "Legal"}.get(opts.page_size.strip().lower())
    if size_key is None:
        size_key = "Letter" if loc_region in _LETTER_REGIONS else "A4"
    page_w, page_h, paper = _PAPERS[size_key]
    flipped = str(opts.orientation or "").strip().lower() == "landscape"
    if flipped:
        page_w, page_h = page_h, page_w
    text_width = page_w - 2 * _MARGIN_X
    text_height = page_h - _MARGIN_Y
    landscape_width = None if flipped else page_h - 2 * _MARGIN_X

    # Footer language: the UI locale, else the document language.
    footer_lang = loc_lang or lang
    footer_key = footer_lang
    if footer_lang == "zh" and (loc_script == "Hant" or loc_region in ("TW", "HK", "MO")):
        footer_key = "zh-Hant"
    footer_pattern = _FOOTERS.get(footer_key) or _FOOTERS.get(footer_lang) or _FOOTERS["en"]

    # Branding (6.2)
    branding = opts.branding if isinstance(opts.branding, dict) else {}
    accent = branding.get("accent_color")
    if accent is not None and not (isinstance(accent, str) and _HEX_COLOR_RE.match(accent.strip())):
        warnings["branding_invalid"] = warnings.get("branding_invalid", 0) + 1
        accent = None
    company = _clean_text(branding.get("company_name"), 120)
    footer_text = _clean_text(branding.get("footer_text"), 200)

    base = tempfile.mkdtemp(prefix="typst-render-")
    try:
        root = os.path.join(base, "root")
        os.mkdir(root, 0o700)
        cache_dir = opts.package_cache_dir
        if not cache_dir:
            cache_dir = os.path.join(base, "package-cache")
            os.mkdir(cache_dir, 0o500)

        logo = None
        logo_bytes = branding.get("logo")
        if logo_bytes:
            checked = None
            if isinstance(logo_bytes, (bytes, bytearray)) and len(logo_bytes) <= MAX_LOGO_BYTES:
                checked = _validate_image(bytes(logo_bytes), MAX_LOGO_PIXELS)
            if checked is None:
                warnings["branding_invalid"] = warnings.get("branding_invalid", 0) + 1
            else:
                name = f"logo.{checked[1]}"
                with open(os.path.join(root, name), "wb") as f:
                    f.write(checked[0])
                logo = "/" + name

        heading_ids = {n["id"] for n in _iter_headings(children) if n.get("id")}
        footnotes = {f["id"]: f for f in tree.get("footnotes", [])}
        builder = _Builder(root=root, text_width=text_width, landscape_width=landscape_width,
                           text_height=text_height, doc_dir=doc_dir, heading_ids=heading_ids,
                           footnotes=footnotes)
        render_tree = builder.blocks(children, top=True)
        if render_tree and render_tree[0]["t"] == "table" and render_tree[0].get("landscape"):
            render_tree[0]["preamble"] = True

        title_heading = None
        if title:
            first = children[0] if children else None
            if not (first and first.get("type") == "heading" and first.get("level") == 1
                    and _normalize_title(pdf_markdown.plain_text(first.get("children", [])))
                    == _normalize_title(title)):
                title_heading = title

        compile_kwargs = dict(root=root, font_paths=[font_dir] if os.path.isdir(font_dir) else [],
                              ignore_system_fonts=True, package_path=package_dir,
                              package_cache_path=cache_dir)

        # Math: check every distinct equation once; failures print as TeX.
        prepared = [p for _, p, _ in builder.math if p]
        distinct = list(dict.fromkeys(prepared))[:MAX_EQUATIONS]
        ok = _check_equations(distinct, compile_kwargs) if distinct else {}
        math_fallbacks = 0
        for node, prep, raw in builder.math:
            if prep and ok.get(prep):
                node["ok"], node["v"] = True, prep
            else:
                node["ok"], node["v"] = False, raw
                math_fallbacks += 1

        meta = {
            "title": title or pdf_markdown.first_h1_text(tree),
            "title_heading": title_heading,
            "lang": lang,
            "region": region,
            "dir": doc_dir,
            "paper": paper,
            "flipped": flipped,
            "fonts": _font_stack(cjk),
            "mono": ["Noto Sans Mono", *_font_stack(cjk)],
            "emoji_fonts": ["Noto Color Emoji", *_font_stack(cjk)],
            "symbol_fonts": ["Noto Sans Symbols 2", *_font_stack(cjk)],
            "math_fonts": ["New Computer Modern Math", "Noto Sans Math", *_font_stack(cjk)],
            "footer": _footer_parts(footer_pattern),
            "footer_dir": "rtl" if footer_lang in _RTL_LANGS else "ltr",
            "footer_text": footer_text,
            "accent": accent.strip() if accent else None,
            "company": company,
            "logo": logo,
            "logo_alt": company or "Logo",
        }
        inputs = {
            "tree": json.dumps(render_tree, ensure_ascii=False, separators=(",", ":")),
            "meta": json.dumps(meta, ensure_ascii=False, separators=(",", ":")),
        }
        try:
            pdf, typst_warnings = typst.compile_with_warnings(_template(), format="pdf", sys_inputs=inputs,
                                                              **compile_kwargs)
        except Exception:
            # Safety net: retry once with every equation as TeX and no images.
            warnings["render_retry"] = 1
            _strip_risky(render_tree)
            inputs["tree"] = json.dumps(render_tree, ensure_ascii=False, separators=(",", ":"))
            try:
                pdf, typst_warnings = typst.compile_with_warnings(_template(), format="pdf",
                                                                  sys_inputs=inputs, **compile_kwargs)
            except Exception:
                raise TypstRenderError("typst compile failed") from None
            math_fallbacks = len(builder.math)
            builder.images_dropped += builder.images
    finally:
        shutil.rmtree(base, ignore_errors=True)

    for w in typst_warnings or ():
        message = str(getattr(w, "message", "") or "")
        kind = "font_missing" if "font" in message.lower() and "unknown" in message.lower() else "typst_warning"
        warnings[kind] = warnings.get(kind, 0) + 1
    missing = len(uncovered_characters(sample + "".join(_texts_of(render_tree)), font_dir))
    if missing:
        warnings["missing_glyph"] = missing
    if math_fallbacks:
        warnings["math_fallback"] = math_fallbacks
    if builder.images_dropped:
        warnings["image_dropped"] = builder.images_dropped
    for kind, count in builder.stats.items():
        warnings[kind] = warnings.get(kind, 0) + count
    return TypstRenderResult(pdf=pdf, pages=_count_pages(pdf), missing_glyphs=missing,
                             math_fallbacks=math_fallbacks, images_dropped=builder.images_dropped,
                             warnings=warnings)


def _iter_headings(nodes):
    for n in nodes:
        if n.get("type") == "heading":
            yield n
        elif n.get("type") in ("blockquote", "bullet_list", "ordered_list", "list_item"):
            yield from _iter_headings(n.get("children", []))


def _texts_of(node) -> list[str]:
    """Strings the template prints that are not in the Markdown plain text
    (math fallbacks, image placeholders): only for the coverage count."""
    out: list[str] = []
    if isinstance(node, list):
        for x in node:
            out.extend(_texts_of(x))
    elif isinstance(node, dict) and node.get("t") in ("math", "mathblock") and not node.get("ok"):
        out.append(node.get("v", ""))
    elif isinstance(node, dict):
        for key in ("c", "items", "cells", "head", "defs", "lead"):
            if key in node:
                out.extend(_texts_of(node[key]))
    return out


def _strip_risky(node) -> None:
    if isinstance(node, list):
        for k, x in enumerate(node):
            if isinstance(x, dict) and x.get("t") == "img":
                node[k] = f"[image: {x['alt']}]" if x.get("alt") else "[image]"
            else:
                _strip_risky(x)
    elif isinstance(node, dict):
        if node.get("t") in ("math", "mathblock") and node.get("ok"):
            node["ok"] = False
        for value in node.values():
            if isinstance(value, (list, dict)):
                _strip_risky(value)


# ---------------------------------------------------------------------------
# Render child setup
# ---------------------------------------------------------------------------

def prepare_render_process(arena_max: int = 2) -> bool:
    """Call once at the start of a dedicated render child, before the first
    render. Typst compiles with worker threads, and glibc gives every thread
    its own 64 MB malloc arena reservation: a 2,000-row table peaks at ~670 MB
    of address space but only ~256 MB resident, so it fails under RLIMIT_AS
    512 MB. Capping the arenas (mallopt M_ARENA_MAX, same effect as the env
    MALLOC_ARENA_MAX=2) brings the peak to ~410 MB. Process-wide: never call
    it in the server process. Returns False where glibc mallopt is unavailable."""
    try:
        import ctypes
        import ctypes.util

        name = ctypes.util.find_library("c")
        if not name:
            return False
        libc = ctypes.CDLL(name)
        m_arena_max = -8
        return bool(libc.mallopt(m_arena_max, int(arena_max)))
    except (OSError, AttributeError):
        return False


# ---------------------------------------------------------------------------
# Selftest (Docker smoke step)
# ---------------------------------------------------------------------------

_SELFTEST_MD = """# Selftest — Łódź, Ελληνικά, Отчёт

Mixed scripts: مرحبا بالعالم, שלום עולם, नमस्ते क्षत्रिय, বাংলা, 你好世界, こんにちは, 안녕하세요, สวัสดี.
Status ✅ done and ❌ blocked, H<sub>2</sub>O, x<sup>2</sup>, <u>underlined</u>, ~~old~~.

- [x] Done
- [ ] Open

| Item | Amount |
|---|---:|
| Base | $120,000 |

Energy \\(E = mc^2\\) and

\\[ \\sum_{k=1}^{n} k = \\frac{n(n+1)}{2} \\]
"""


def selftest() -> None:
    """Render a small mixed-script document; raise RuntimeError on any problem.

    Used by the image smoke step: fails when typst, the bundled fonts, the
    vendored mitex package or the template are missing or broken."""
    if not _font_files(DEFAULT_FONT_DIR):
        raise RuntimeError("bundled fonts missing: run scripts/fetch_fonts.py")
    if not os.path.isfile(os.path.join(DEFAULT_PACKAGE_DIR, "preview", "mitex", "0.2.7", "typst.toml")):
        raise RuntimeError("vendored mitex package missing")
    result = render_markdown_typst(_SELFTEST_MD, None, TypstRenderOptions(locale="en-US"))
    problems = []
    if not result.pdf.startswith(b"%PDF-") or result.pages < 1:
        problems.append("no PDF")
    if result.missing_glyphs:
        problems.append(f"missing_glyphs={result.missing_glyphs}")
    if result.math_fallbacks:
        problems.append(f"math_fallbacks={result.math_fallbacks}")
    if b"/Lang" not in result.pdf or b"/StructTreeRoot" not in result.pdf:
        problems.append("untagged")
    if problems:
        raise RuntimeError("pdf_typst selftest failed: " + ", ".join(problems))


if __name__ == "__main__":  # python -m graph_tools.tools.pdf_typst --selftest
    import sys

    if "--selftest" in sys.argv:
        selftest()
        print("pdf_typst selftest OK")
