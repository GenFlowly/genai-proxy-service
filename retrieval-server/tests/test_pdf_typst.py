"""
Tests for graph_tools.tools.pdf_typst, the Typst PDF renderer (plan 5.1, with
the acceptance criteria moved in from 2.2, 2.3, 2.5 and 2.6, plus 6.1/6.2).

PDFs are checked with pypdfium2 (text layer, character boxes, fonts, images,
bookmarks, /Lang). Tests that render need the bundled fonts; they skip with a
message when graph_tools/fonts has not been fetched:

    cd retrieval-server && python scripts/fetch_fonts.py

Run with `python -m unittest tests.test_pdf_typst`.
"""
import ctypes
import importlib.util
import io
import json
import os
import random
import re
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import unicodedata
import unittest
from unittest import mock

from graph_tools.tools import pdf_typst

HERE = os.path.dirname(os.path.abspath(__file__))
RETRIEVAL = os.path.dirname(HERE)
FIXTURES = os.path.join(HERE, "fixtures", "pdf")
SCRIPTS = os.path.join(RETRIEVAL, "scripts")

try:
    import pypdfium2 as pdfium
    import pypdfium2.raw as pdfium_c
    RENDER_DEPS = importlib.util.find_spec("typst") is not None
except ImportError:  # pragma: no cover
    RENDER_DEPS = False

FONTS_PRESENT = bool(pdf_typst._font_files(pdf_typst.DEFAULT_FONT_DIR))
SKIP_REASON = ("bundled fonts missing: run `python scripts/fetch_fonts.py` in retrieval-server/ "
               "(or typst/pypdfium2 not installed)")
needs_render = unittest.skipUnless(FONTS_PRESENT and RENDER_DEPS, SKIP_REASON)
MARGIN_X = 51.0236  # 1.8cm, pdf_template.typ


def _load_script(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(SCRIPTS, name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fixture(name: str) -> str:
    with open(os.path.join(FIXTURES, name), encoding="utf-8") as f:
        return f.read()


# Generated fixtures (the investigators' 20/21/23/24 files, reproduced exactly,
# instead of committing ~400 KB).
def export_table(rows: int) -> str:
    head = ("# Export\n\n| ID | Name | Orders | Rate | Date | Status | Region | Value | Note | Flag |\n"
            "|---|---|---|---|---|---|---|---|---|---|\n")
    return head + "".join(
        f"| {r} | Customer {r} | {r * 37 % 1000} | {r * 13 % 97}.5% | 2026-{r % 9 + 1:02d}-{r % 9 + 10} "
        f"| active | region-{r % 7} | {r * 101 % 10000} | note {r} | ok |\n" for r in range(1, rows + 1))


def ledger_table(rows: int) -> str:
    """The typst-case ledger (6 columns) the 2,000-row bound was measured on."""
    body = "\n".join(f"| {r} | Customer {r} | {r * 31 % 1000} | {r * 2.25:.2f} | Region {r % 7} | "
                     f"{'open' if r % 3 else 'closed'} |" for r in range(1, rows + 1))
    return "# Ledger\n\n| # | Customer | Units | Amount | Region | Status |\n|---|---|---|---|---|---|\n" + body + "\n"


def long_doc(target_words: int) -> str:
    rnd = random.Random(42)
    words = ("revenue customer platform growth margin quarter pipeline retention analysis forecast operating "
             "segment strategy investment product market regional enterprise subscription usage support "
             "infrastructure latency reliability throughput compliance security roadmap initiative stakeholder "
             "budget variance").split()

    def para(n):
        s = []
        while sum(len(x.split()) for x in s) < n:
            w = [rnd.choice(words) for _ in range(rnd.randint(8, 20))]
            w[0] = w[0].capitalize()
            s.append(" ".join(w) + ".")
        return " ".join(s)

    out, total, sec = ["# Annual Operating Report", ""], 0, 0
    while total < target_words:
        sec += 1
        out += [f"## {sec}. Section {sec}", ""]
        for _ in range(3):
            p = para(120)
            out += [p, ""]
            total += len(p.split())
        out += ["### Key points", ""]
        for i in range(4):
            li = para(12)
            out.append(f"- **Point {i + 1}:** {li}")
            total += len(li.split()) + 2
        out.append("")
        if sec % 3 == 0:
            out += ["| Metric | Q1 | Q2 | Q3 | Q4 |", "|---|---:|---:|---:|---:|"]
            for m in ["Revenue", "Margin", "Customers", "Churn"]:
                out.append(f"| {m} | {rnd.randint(100, 999)} | {rnd.randint(100, 999)} | "
                           f"{rnd.randint(100, 999)} | {rnd.randint(100, 999)} |")
                total += 5
            out.append("")
        if sec % 5 == 0:
            out += ["```", "SELECT region, SUM(amount) FROM orders GROUP BY region;", "```", ""]
    return "\n".join(out)


GENERATED = {
    "20_long_5k.md": lambda: long_doc(5000),
    "21_long_20k.md": lambda: long_doc(20000),
    "23_table_1000rows.md": lambda: export_table(1000),
    "24_table_50rows.md": lambda: export_table(50),
    "24_table_100rows.md": lambda: export_table(100),
    "24_table_250rows.md": lambda: export_table(250),
    "24_table_500rows.md": lambda: export_table(500),
}


class Rendered:
    """A render result with its pdfium document and per-page text helpers."""

    def __init__(self, result):
        self.result = result
        self.doc = pdfium.PdfDocument(result.pdf)
        self.textpages = [self.doc[i].get_textpage() for i in range(len(self.doc))]
        self.text = "\n".join(tp.get_text_range() for tp in self.textpages)

    def chars(self, page: int):
        """[(char, left, bottom, right, top)] of a page, spaces included."""
        tp = self.textpages[page]
        out = []
        for i in range(tp.count_chars()):
            out.append((tp.get_text_range(i, 1),) + tuple(tp.get_charbox(i)))
        return out

    def find(self, needle: str):
        """(page, [boxes]) of the first occurrence of needle in the text layer."""
        for p, tp in enumerate(self.textpages):
            text = tp.get_text_range()
            k = text.find(needle)
            if k >= 0:
                return p, [tp.get_charbox(i) for i in range(k, k + len(needle))]
        raise AssertionError(f"{needle!r} not in the text layer")

    def font_of(self, needle: str):
        p, _ = self.find(needle)
        tp = self.textpages[p]
        k = tp.get_text_range().find(needle)
        buf = ctypes.create_string_buffer(256)
        flags = ctypes.c_int()
        pdfium_c.FPDFText_GetFontInfo(tp.raw, k, buf, 256, ctypes.byref(flags))
        return buf.value.decode(errors="replace"), pdfium_c.FPDFText_GetFontWeight(tp.raw, k)

    def lang(self) -> str:
        n = pdfium_c.FPDFCatalog_GetLanguage(self.doc.raw, None, 0)
        buf = (ctypes.c_ushort * max(1, n // 2))()
        pdfium_c.FPDFCatalog_GetLanguage(self.doc.raw, buf, n)
        return bytes(buf).decode("utf-16-le").rstrip("\x00")

    def images(self, page: int):
        return list(self.doc[page].get_objects(filter=[pdfium_c.FPDF_PAGEOBJ_IMAGE], max_depth=8))

    def lines(self, page: int) -> list[str]:
        """Text lines of a page as pdfium extracts them (top to bottom)."""
        return [line.strip() for line in self.textpages[page].get_text_range().split("\r\n")]


_cache: dict = {}


def render(md: str, title=None, **options) -> Rendered:
    key = (md, title, repr(sorted(options.items())))
    if key not in _cache:
        _cache[key] = Rendered(pdf_typst.render_markdown_typst(md, title, pdf_typst.TypstRenderOptions(**options)))
    return _cache[key]


def render_fixture(name: str) -> Rendered:
    md = GENERATED[name]() if name in GENERATED else fixture(name)
    return render(md)


def chars_past_right_margin(r: Rendered) -> int:
    over = 0
    for p in range(len(r.doc)):
        limit = r.doc[p].get_width() - MARGIN_X + 1.0
        over += sum(1 for ch, l, b, right, t in r.chars(p) if ch.strip() and right > limit)
    return over


def overlapping_glyphs(r: Rendered) -> int:
    """Glyph boxes on one line that overlap their left neighbour by > 0.6 pt
    (text from one table cell running into the next). Characters sharing one
    ligature glyph ('fi', 'fl') report the same box and are not overlaps."""
    bad = 0
    for p in range(len(r.doc)):
        rows = {}
        for ch, l, b, right, t in r.chars(p):
            if not ch.strip() or unicodedata.category(ch)[0] in "MC" or right - l < 0.5:
                continue
            rows.setdefault(round(b * 2), []).append((l, right))
        for boxes in rows.values():
            boxes.sort()
            for (l1, r1), (l2, r2) in zip(boxes, boxes[1:]):
                same_glyph = abs(l1 - l2) < 0.5 and abs(r1 - r2) < 0.5
                if l2 < r1 - 0.6 and not same_glyph:
                    bad += 1
    return bad


# ---------------------------------------------------------------------------

@needs_render
class GoldenBatteryTests(unittest.TestCase):
    """5.1: the 30 rendering fixtures plus rtl_ar, rtl_he and mixed (and the
    other fixtures in tests/fixtures/pdf): inside the margins, no boxes, every
    character covered by a bundled font."""

    EXPECTED = {
        "01_latin_accents.md": ["Zażółć gęślą jaźń", "Příliš žluťoučký kůň", "İstanbul", "Đà Nẵng", "Țară, școală"],
        "02_greek.md": ["Ελληνικά", "αλεπού"],
        "03_cyrillic.md": ["Отчёт за квартал", "ґудзики", "Љубазни"],
        "06_hindi.md": ["क्षत्रिय", "रिपोर्ट"],
        "07_chinese.md": ["季度报告", "繁體中文"],
        "08_japanese.md": ["四半期報告書", "カタカナ"],
        "12_code.md": ["def handler(request):"],
        "13_table10.md": ["Supercalifragilisticexpialidocious", "$1,234,567"],
        "17_links.md": ["the documentation", "https://example.com/bare"],
        "22_llm_habits.md": ["Dear <Candidate Name>,", "<Your Name>"],
        "mixed.md": ["Łódź", "Ελληνικά", "क्षत्रिय"],
        "typst_syntax_prose.md": ["#set page(width: 1pt)"],
    }

    def test_every_fixture(self):
        names = sorted(n for n in os.listdir(FIXTURES) if n.endswith(".md")) + sorted(GENERATED)
        self.assertGreaterEqual(len(names), 37)
        for name in names:
            with self.subTest(fixture=name):
                r = render_fixture(name)
                self.assertTrue(r.result.pdf.startswith(b"%PDF-"))
                self.assertEqual(r.result.pages, len(r.doc))
                self.assertEqual(chars_past_right_margin(r), 0)
                self.assertNotIn("\u25a0", r.text)
                self.assertEqual(r.result.missing_glyphs, 0)
                for s in self.EXPECTED.get(name, []):
                    self.assertIn(s, r.text)

    def test_cmap_coverage_of_every_fixture_is_complete(self):
        for name in sorted(n for n in os.listdir(FIXTURES) if n.endswith((".md", ".txt"))):
            with self.subTest(fixture=name):
                self.assertEqual(pdf_typst.uncovered_characters(fixture(name)), set())

    def test_long_documents(self):
        r = render_fixture("21_long_20k.md")
        self.assertGreater(r.result.pages, 30)
        self.assertIn("Annual Operating Report", r.text)


@needs_render
class LatinGreekCyrillicTests(unittest.TestCase):
    """Moved from 2.3."""

    def test_extended_latin_greek_and_cyrillic_strings(self):
        r = render("Łódź, Žluťoučký kůň, İstanbul, Đà Nẵng, Erdős.\n\n# Ελληνικά\n\nОтчёт за квартал.\n")
        for s in ("Łódź", "Žluťoučký", "İstanbul", "Đà Nẵng", "Erdős", "Ελληνικά", "Отчёт"):
            self.assertIn(s, r.text)
        self.assertNotIn("\u25a0", r.text)
        self.assertEqual(r.result.missing_glyphs, 0)

    def test_greek_heading_is_bold(self):
        r = render("# Ελληνικά\n\nκείμενο\n")
        name, weight = r.font_of("Ελληνικά")
        self.assertIn("Bold", name)
        self.assertGreaterEqual(weight, 600)
        self.assertNotIn("Bold", r.font_of("κείμενο")[0])


@needs_render
class StructureFromTokenTreeTests(unittest.TestCase):
    """Moved from 2.2, checked on the rendered text."""

    def test_llm_habits(self):
        r = render_fixture("22_llm_habits.md")
        self.assertIn("Dear <Candidate Name>,", r.text)
        self.assertIn("<Your Name>", r.text)
        self.assertNotIn("| Item | Amount |", r.text)
        self.assertNotIn("|", r.text.replace("a_b_c", ""))
        lines = r.lines(0)
        for item in ("Health insurance", "25 days of paid leave", "Stock options"):
            self.assertIn("• " + item, lines)  # one bulleted line each
        # a 2-column table: 'Item' and 'Amount' share a row, values line up under them
        _, item = r.find("Item")
        _, amount = r.find("Amount")
        _, salary = r.find("Base salary")
        _, value = r.find("$120,000")
        self.assertAlmostEqual(item[0][1], amount[0][1], delta=1.0)
        self.assertAlmostEqual(item[0][0], salary[0][0], delta=1.0)
        self.assertAlmostEqual(amount[0][0], value[0][0], delta=1.0)
        self.assertGreater(amount[0][0], salary[-1][2])

    def _x0(self, r, text):
        return r.find(text)[1][0][0]

    def test_nested_lists(self):
        r = render_fixture("14_nested_lists.md")
        self.assertIn("3. First level three", r.text)
        self.assertIn("5. List starting at five", r.text)
        self.assertGreater(self._x0(r, "Second level bullet"), self._x0(r, "First level one"))
        self.assertGreater(self._x0(r, "Third level bullet"), self._x0(r, "Second level bullet"))
        self.assertGreater(self._x0(r, "Sub-number a"), self._x0(r, "First level two"))

    def test_d9_probe(self):
        r = render_fixture("d9_probe.md")
        self.assertIn("2. First level three", r.text)  # numbered as written, not renumbered
        self.assertGreater(self._x0(r, "Second level bullet"), self._x0(r, "First level one"))  # 3 spaces
        self.assertGreater(self._x0(r, "Child bullet two-space"), self._x0(r, "Parent bullet"))  # 2 spaces
        self.assertGreater(self._x0(r, "Sub-clause a"), self._x0(r, "Clause one"))

    def test_task_list_and_strikethrough(self):
        r = render("- [x] Done\n- [ ] Open\n\n~~old~~ text\n")
        self.assertIn("\u2611", r.text)
        self.assertIn("\u2610", r.text)
        self.assertNotIn("[x]", r.text)
        self.assertNotIn("[ ]", r.text)
        self.assertNotIn("~", r.text)
        self.assertIn("old text", r.text)

    def test_address_block_extracts_as_four_lines(self):
        r = render("Jane Doe\n123 Main St\nSpringfield, IL 62704\nUSA\n")
        self.assertEqual(r.lines(0)[:4], ["Jane Doe", "123 Main St", "Springfield, IL 62704", "USA"])

    def test_raw_html_allowlist(self):
        r = render("H<sub>2</sub>O, x<sup>2</sup> and <u>underlined</u>.\n\n"
                   "| Plan | Notes |\n|---|---|\n| Line one<br>Line two | x |\n\n"
                   "<img src=https://example.com/a.png>\n")
        self.assertIn("H2O", r.text)
        self.assertIn("x2 and underlined", r.text)
        self.assertIn("<img src=https://example.com/a.png>", r.text)
        _, one = r.find("Line one")
        _, two = r.find("Line two")
        self.assertLess(two[0][1], one[0][1] - 5)  # second line below the first
        self.assertEqual(r.images(0), [])


@needs_render
class RtlTests(unittest.TestCase):
    def _sentence_y(self, r, number):
        """Vertical centre of the standalone sentence number (ASCII digits extract cleanly)."""
        for tp in r.textpages:
            m = re.search(rf"(?<!\d){number}(?!\d)", tp.get_text_range())
            if m:
                _, b, _, t = tp.get_charbox(m.start())
                return (b + t) / 2
        raise AssertionError(number)

    def test_arabic_paragraph_line_order(self):
        r = render_fixture("rtl_ar.md")
        y01, y30 = self._sentence_y(r, "01"), self._sentence_y(r, "30")
        ys = [self._sentence_y(r, f"{i:02d}") for i in range(1, 31)]
        self.assertEqual(y01, max(ys))  # sentence 01 on the top line
        self.assertEqual(y30, min(ys))  # sentence 30 on the last line
        self.assertGreater(y01 - y30, 50)  # a real multi-line paragraph

    def test_hebrew_paragraph_line_order(self):
        r = render_fixture("rtl_he.md")
        ys = [self._sentence_y(r, f"{i:02d}") for i in range(1, 31)]
        self.assertEqual(ys[0], max(ys))
        self.assertEqual(ys[-1], min(ys))

    def test_rtl_list_bullets_on_the_right(self):
        for name in ("rtl_ar.md", "rtl_he.md"):
            r = render_fixture(name)
            chars = [(ch, l, (b + t) / 2) for ch, l, b, right, t in r.chars(0) if ch.strip()]
            bullets = [(l, y) for ch, l, y in chars if ch == "\u2022"]
            self.assertEqual(len(bullets), 2, name)
            for bx, by in bullets:
                item_x = [l for ch, l, y in chars if ch != "\u2022" and abs(y - by) < 4]
                self.assertTrue(item_x, name)
                self.assertGreater(bx, max(item_x), name)  # the bullet is right of its item text

    def test_rtl_table_columns_run_right_to_left(self):
        r = render_fixture("rtl_ar.md")
        _, first_col = r.find("51")    # row 1, column 1 ('الرياض 51')
        _, second_col = r.find("1200")  # row 1, column 2
        self.assertGreater(first_col[0][0], second_col[0][0])

    def test_lang_tag(self):
        self.assertEqual(render_fixture("rtl_ar.md").lang(), "ar")
        self.assertEqual(render_fixture("rtl_he.md").lang(), "he")


@needs_render
class IndicAndCjkTests(unittest.TestCase):
    def test_devanagari_in_text_layer_and_shaped(self):
        r = render_fixture("06_hindi.md")
        self.assertIn("क्षत्रिय", r.text)
        self.assertIn("रिपोर्ट", r.text)
        # Raster check: the conjunct (क्ष, द्वि) is narrower than the same code
        # points with ZWNJ preventing conjunct formation.
        joined = render("क्षत्रिय द्वितीय")
        broken = render("क्\u200cषत्\u200cरिय द्\u200cवितीय")
        self.assertLess(self._ink_width(joined), self._ink_width(broken) * 0.95)

    @staticmethod
    def _ink_width(r):
        img = r.doc[0].render(scale=3).to_pil().convert("L")
        w, h = img.size
        top = img.crop((0, 0, w, h // 4)).point(lambda v: 255 if v < 128 else 0)
        left, _, right, _ = top.getbbox()
        return right - left

    def test_cjk_paragraph_inside_the_margins(self):
        """Every character of edge.md's long Chinese paragraph lies inside the
        margins (the plan counts 286; the paragraph has 300 characters, 282 of
        them ideographs, and all 300 are checked)."""
        para = fixture("edge.md").split("Long Chinese paragraph:")[1].split("\n")[0].strip()
        self.assertEqual(len(para), 300)
        r = render_fixture("edge.md")
        width = r.doc[0].get_width()
        tp = r.textpages[0]
        text = tp.get_text_range()
        k = text.find("paragraph:") + len("paragraph:")
        inside = 0
        seen = 0
        while seen < len(para) and k < len(text):
            ch = text[k]
            if not ch.isspace():
                self.assertEqual(ch, para[seen])
                l, b, right, t = tp.get_charbox(k)
                if l >= MARGIN_X - 1 and right <= width - MARGIN_X + 1:
                    inside += 1
                seen += 1
            k += 1
        self.assertEqual((seen, inside), (300, 300))

    def test_latin_word_in_cjk_paragraph_is_not_split(self):
        r = render_fixture("mixed.md")
        _, boxes = r.find("Internationalization")
        bottoms = [b[1] for b in boxes]
        self.assertLess(max(bottoms) - min(bottoms), 3)  # one line
        self.assertEqual([b[0] for b in boxes], sorted(b[0] for b in boxes))

    def test_cjk_font_order_per_document(self):
        self.assertIn("NotoSansJP", render_fixture("08_japanese.md").font_of("東京都")[0])
        self.assertIn("NotoSansSC", render_fixture("07_chinese.md").font_of("季度报告")[0])
        self.assertIn("NotoSansKR", render("# 보고서\n\n안녕하세요 世界").font_of("世界")[0])


@needs_render
class MathTests(unittest.TestCase):
    def test_corpus(self):
        corpus = [line for line in fixture("math_corpus.txt").splitlines() if line.strip()]
        self.assertEqual(len(corpus), 30)
        r = render("\n\n".join(f"\\[ {tex} \\]" for tex in corpus))
        self.assertLessEqual(r.result.math_fallbacks, 1)       # at least 29 of 30 typeset
        self.assertEqual(r.result.warnings.get("math_fallback"), 1)
        self.assertIn("\\foo{x} + 1", r.text)                     # the one fallback, as TeX

    def test_unknown_command_falls_back_without_failing(self):
        r = render("Before \\(\\foo{a*b} \\{x\\} \\\\ y\\) after \\(E = mc^2\\).")
        self.assertEqual(r.result.math_fallbacks, 1)
        self.assertIn("\\(\\foo{a*b} \\{x\\} \\\\ y\\)", r.text)  # byte-exact source
        self.assertIn("Before", r.text)
        self.assertIn("after", r.text)

    def test_d17_corpus_is_typeset_not_corrupted(self):
        md = ("Inline \\( E = mc^2 \\) and display:\n\n\\[ \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix} \\]\n\n"
              "Set \\( \\{x\\} \\), emphasis risk \\( a*b*c \\).\n")
        r = render(md)
        self.assertEqual(r.result.math_fallbacks, 0)
        self.assertNotIn("\\(", r.text)
        self.assertNotIn("\\[", r.text)
        text = re.sub(r"\s+", "", unicodedata.normalize("NFKC", r.text))  # superscripts extract on their own line
        self.assertIn("E=mc2", text)
        self.assertRegex(text, r"a[∗*]b[∗*]c")  # the asterisks survive (no emphasis inside math)

    def test_cases_second_row_keeps_its_gap(self):
        r = render("\\[ f(x) = \\begin{cases} x^2 & x \\geq 0 \\\\ -x & x < 0 \\end{cases} \\]")
        text = unicodedata.normalize("NFKC", r.text)
        self.assertRegex(text, r"−x\s+x < 0")

    def test_dollars_are_literal(self):
        r = render("A price of $100 and \\$100, $x^2$.\n")
        self.assertIn("A price of $100 and $100, $x^2$.", r.text)
        self.assertEqual(r.result.math_fallbacks, 0)

    def test_mitex_eval_path_leaks_no_file_content(self):
        """mitex evaluates converted TeX (mitex.typ:27/:34; \\hspace, \\vspace and
        \\raisebox evaluate their argument). Hostile TeX must not read files."""
        hostile = [
            '\\text{#read("canary.txt")}',
            '\\operatorname{#read("canary.txt")}',
            '\\hspace{read("canary.txt").len() * 1pt} x',
            '\\raisebox{panic(read("/canary.txt"))}{y}',
            '\\includegraphics{canary.txt}',
        ]
        import typst

        root = tempfile.mkdtemp()
        cache = tempfile.mkdtemp()
        try:
            with open(os.path.join(root, "canary.txt"), "w") as f:
                f.write("CANARY-6f1d")
            src = b'#import "@preview/mitex:0.2.7": mitex\n#mitex(sys.inputs.m)\n'
            for tex in hostile:
                try:
                    pdf = typst.compile(src, root=root, ignore_system_fonts=True, sys_inputs={"m": tex},
                                        package_path=pdf_typst.DEFAULT_PACKAGE_DIR, package_cache_path=cache)
                except Exception:
                    continue  # refused: fine
                text = "".join(pdfium.PdfDocument(pdf)[i].get_textpage().get_text_range()
                               for i in range(len(pdfium.PdfDocument(pdf))))
                self.assertNotIn("CANARY", text, tex)
            self.assertEqual(os.listdir(cache), [])
        finally:
            shutil.rmtree(root, ignore_errors=True)
            shutil.rmtree(cache, ignore_errors=True)
        # Through the renderer: the filter refuses the eval-argument forms (they
        # print as TeX), the document renders, and nothing from the template or
        # the package leaks into it.
        for tex in hostile[2:]:
            self.assertFalse(pdf_typst._tex_is_safe(tex), tex)
        self.assertTrue(pdf_typst._tex_is_safe("\\hspace{1em} x \\raisebox{2pt}{y}"))
        r = render("\n\n".join(f"\\[ {tex} \\]" for tex in hostile))
        self.assertGreaterEqual(r.result.math_fallbacks, 3)
        for marker in ("CANARY", "mitex-wasm", "sys.inputs", "#let"):
            self.assertNotIn(marker, r.text)


@needs_render
class LiteralSyntaxAndNetworkTests(unittest.TestCase):
    def test_typst_syntax_in_prose_prints_literally_and_cache_stays_empty(self):
        cache = tempfile.mkdtemp()
        os.chmod(cache, 0o500)
        try:
            r = Rendered(pdf_typst.render_markdown_typst(
                fixture("typst_syntax_prose.md"), None, pdf_typst.TypstRenderOptions(package_cache_dir=cache)))
            self.assertEqual(os.listdir(cache), [])
        finally:
            os.chmod(cache, 0o700)
            shutil.rmtree(cache, ignore_errors=True)
        text = r.text.replace("\r\n", " ").replace("\n", " ")
        for s in ('#set page(width: 1pt)', '#read("data.csv")', '#import "@preview/cetz:0.3.0"',
                  '= This line starts with an equals sign', '<intro>', '@intro', '$x^2$', 'costs $5',
                  'A backslash \\ and a hash #', 'braces {} and brackets []', '#{ 1 + 1 }',
                  '#let x = 1', '#emph[hi]'):
            self.assertIn(s, text)
        self.assertEqual(r.result.pages, 1)

    def test_nothing_is_fetched(self):
        def refuse(*args, **kwargs):
            raise AssertionError("network access attempted")

        md = ("![x](https://example.com/a.png)\n\n<img src=\"https://example.com/b.png\">\n\n"
              "<style>@import url(https://example.com/c.css)</style>\n\nSee https://example.com/d.\n")
        with mock.patch.object(socket.socket, "connect", refuse), \
                mock.patch.object(socket, "create_connection", refuse):
            result = pdf_typst.render_markdown_typst(md)
        r = Rendered(result)
        self.assertIn("[image: x]", r.text)
        self.assertIn('<img src="https://example.com/b.png">', r.text)
        self.assertEqual(result.images_dropped, 1)


def _png(color, size=(40, 30)) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


def _data_uri(blob: bytes, mime="image/png") -> str:
    import base64

    return f"data:{mime};base64," + base64.b64encode(blob).decode()


@needs_render
class ImageTests(unittest.TestCase):
    def test_two_distinct_data_uri_pngs_make_two_images(self):
        r = render(f"![red]({_data_uri(_png((220, 20, 20)))})\n\n![blue]({_data_uri(_png((20, 20, 220)))})\n")
        imgs = r.images(0)
        self.assertEqual(len(imgs), 2)
        colors = []
        for im in imgs:
            pil = im.get_bitmap().to_pil().convert("RGB")
            colors.append(pil.getpixel((pil.size[0] // 2, pil.size[1] // 2)))
        self.assertNotEqual(colors[0], colors[1])
        self.assertEqual(r.result.images_dropped, 0)

    def test_fixture_with_a_large_data_uri_image(self):
        r = render_fixture("16_image_datauri.md")
        self.assertEqual(len(r.images(0)), 2)
        self.assertEqual(chars_past_right_margin(r), 0)

    def test_invalid_oversized_and_remote_images_become_placeholders(self):
        huge = _data_uri(_png((0, 0, 0), size=(5000, 3000)))  # 15 MP > the per-image cap
        md = (f"![broken](data:image/png;base64,iVBORw0KGgoAAAA)\n\n![huge]({huge})\n\n"
              "![remote](https://example.com/x.png)\n\n![svg](data:image/svg+xml;base64,PHN2Zy8+)\n")
        r = render(md)
        for alt in ("broken", "huge", "remote"):
            self.assertIn(f"[image: {alt}]", r.text)
        self.assertIn("![svg](data:image/svg+xml", r.text)  # markdown-it refuses SVG data links: literal
        self.assertEqual(r.result.images_dropped, 3)
        self.assertEqual(r.images(0), [])

    def test_image_typst_cannot_decode_triggers_the_safe_retry(self):
        """PIL's verify() checks PNG chunk CRCs, not the compressed pixels. An
        image Typst then fails on must not fail the document: the renderer
        retries once without images and with every equation as TeX."""
        import struct
        import zlib

        def chunk(tag, data):
            return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

        bad_png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 8, 8, 8, 2, 0, 0, 0))
                   + chunk(b"IDAT", b"not zlib data at all") + chunk(b"IEND", b""))
        result = pdf_typst.render_markdown_typst(f"Text \\(x^2\\)\n\n![bad]({_data_uri(bad_png)})\n")
        self.assertTrue(result.pdf.startswith(b"%PDF-"))
        self.assertEqual(result.warnings.get("render_retry"), 1)
        self.assertEqual(result.images_dropped, 1)
        self.assertIn("[image: bad]", Rendered(result).text)

    def test_gif_is_converted(self):
        from PIL import Image

        buf = io.BytesIO()
        Image.new("RGB", (30, 20), (10, 200, 10)).save(buf, "GIF")
        r = render(f"![g]({_data_uri(buf.getvalue(), 'image/gif')})")
        self.assertEqual(len(r.images(0)), 1)


@needs_render
class WideContentTests(unittest.TestCase):
    """Moved from 2.6: nothing past the right margin, no overlapping cells."""

    def test_wide_tables_code_and_long_tokens(self):
        for name in ("13_table10.md", "vt_table8.md", "vt_url3.md", "12_code.md", "25_long_tokens.md", "mixed.md"):
            with self.subTest(fixture=name):
                r = render_fixture(name)
                self.assertEqual(chars_past_right_margin(r), 0)
                self.assertEqual(overlapping_glyphs(r), 0)

    def test_very_wide_table_gets_a_landscape_page_with_its_heading(self):
        r = render_fixture("13_table10.md")
        self.assertEqual(r.result.warnings.get("landscape_table"), 1)
        sizes = [(round(r.doc[i].get_width()), round(r.doc[i].get_height())) for i in range(len(r.doc))]
        self.assertIn((842, 595), sizes)
        page, _ = r.find("Ten-column table")
        self.assertEqual(sizes[page], (842, 595))
        self.assertEqual(r.find("Supercalifragilisticexpialidocious")[0], page)

    def test_long_python_line_copies_back_unchanged(self):
        source = next(line for line in fixture("12_code.md").split("\n") if "result = some_service" in line)
        self.assertGreater(len(source), 150)
        r = render_fixture("12_code.md")
        text = r.text
        start = text.find("result = some_service")
        end = text.find("temperature=0.2)") + len("temperature=0.2)")
        copied = text[start:end].replace("\r\n", "").replace("\n", "")
        self.assertEqual(re.sub(r"\s+", "", copied), re.sub(r"\s+", "", source))
        self.assertTrue(set(copied) <= set(source) | {" "})

    def test_unbreakable_token_in_a_narrow_cell(self):
        token = "0x" + "8f3a9b2c7d1e4f6a5b8c9d0e1f2a3b4c" * 3
        r = render(f"| Hash | Other | Third |\n|---|---|---|\n| {token} | x | y |\n\nPara {token * 2} end.\n")
        self.assertEqual(chars_past_right_margin(r), 0)
        self.assertEqual(overlapping_glyphs(r), 0)
        self.assertIn(token, r.text.replace("\r\n", "").replace("\n", ""))

    def test_code_line_without_break_opportunity(self):
        blob = "QUJD" * 60
        r = render(f"```\nkey = \"{blob}\"\n```\n")
        self.assertEqual(chars_past_right_margin(r), 0)
        self.assertIn(blob, r.text.replace("\r\n", "").replace("\n", ""))


@needs_render
class EmojiAndSymbolTests(unittest.TestCase):
    @staticmethod
    def _coloured_pixels(r, needle):
        img = r.doc[0].render(scale=2).to_pil().convert("RGB")
        _, boxes = r.find(needle)
        l, b, right, t = boxes[0]
        h = r.doc[0].get_height()
        crop = img.crop((int(l * 2), int((h - t) * 2), int(right * 2) + 1, int((h - b) * 2) + 1))
        return sum(1 for px in crop.getdata() if max(px) - min(px) > 60)

    def test_status_emoji_render_in_colour(self):
        r = render("Done \u2705 and star \u2b50 and \u26a0\ufe0f\n")
        self.assertNotIn("\u25a0", r.text)
        for ch in ("\u2705", "\u2b50", "\u26a0"):
            self.assertGreater(self._coloured_pixels(r, ch), 20, ch)

    def test_text_symbols_stay_monochrome(self):
        r = render("Check marks: \u2713 \u2714 \u2717 \u2610 \u2611.")
        for ch in "\u2713\u2717\u2610\u2611":
            self.assertTrue(r.font_of(ch)[0], ch)  # a named outline font, not the Type3 colour font
            self.assertEqual(self._coloured_pixels(r, ch), 0, ch)

    def test_emoji_split(self):
        parts = pdf_typst._split_emoji("ok \u2705 \U0001F44D\U0001F3FD fam \U0001F468\u200d\U0001F469\u200d\U0001F467 "
                                      "\U0001F1FA\U0001F1F8 \u26a0\ufe0f 1\ufe0f\u20e3 \u2713")
        emoji = [p["v"] for p in parts if isinstance(p, dict)]
        self.assertEqual(emoji, ["\u2705", "\U0001F44D\U0001F3FD", "\U0001F468\u200d\U0001F469\u200d\U0001F467",
                                 "\U0001F1FA\U0001F1F8", "\u26a0\ufe0f", "1\ufe0f\u20e3"])
        self.assertEqual(pdf_typst._split_emoji("plain ascii 123"), ["plain ascii 123"])


@needs_render
class PageLocaleAndFooterTests(unittest.TestCase):
    """6.1: page size from the locale, localised footer computed from the page."""

    def _footer(self, r, page=0):
        width = r.doc[page].get_width()
        tp = r.textpages[page]
        boxes = [tp.get_charbox(i) for i in range(tp.count_chars())
                 if tp.get_text_range(i, 1).strip() and tp.get_charbox(i)[3] < 58]
        text = tp.get_text_bounded(0, 0, width, 58).strip()
        centre = (min(b[0] for b in boxes) + max(b[2] for b in boxes)) / 2
        return text, centre - width / 2

    def test_us_english_is_letter(self):
        r = render("# Hi\n\nBody.", locale="en-US")
        self.assertEqual((round(r.doc[0].get_width()), round(r.doc[0].get_height())), (612, 792))
        text, off = self._footer(r)
        self.assertEqual(text, "Page 1 of 1")
        self.assertLessEqual(abs(off), 1.0)

    def test_canadian_english_is_letter(self):
        r = render("Body.", locale="en-CA")
        self.assertEqual(round(r.doc[0].get_width()), 612)

    def test_german_is_a4_with_a_german_footer(self):
        r = render("# Hallo\n\nText.", locale="de-DE")
        self.assertEqual((round(r.doc[0].get_width()), round(r.doc[0].get_height())), (595, 842))
        self.assertEqual(self._footer(r)[0], "Seite 1 von 1")
        self.assertEqual(r.lang(), "de-DE")

    def test_a4_landscape_footer_is_centred(self):
        r = render("Body " * 50, page_size="A4", orientation="landscape")
        self.assertEqual((round(r.doc[0].get_width()), round(r.doc[0].get_height())), (842, 595))
        self.assertLessEqual(abs(self._footer(r)[1]), 1.0)

    def test_explicit_size_wins_and_legal(self):
        self.assertEqual(round(render("x", page_size="A4", locale="en-US").doc[0].get_width()), 595)
        r = render("x", page_size="Legal")
        self.assertEqual((round(r.doc[0].get_width()), round(r.doc[0].get_height())), (612, 1008))

    def test_footer_counts_pages(self):
        r = render_fixture("20_long_5k.md")
        n = len(r.doc)
        self.assertGreater(n, 3)
        self.assertEqual(self._footer(r, n - 1)[0], f"Page {n} of {n}")

    def test_footer_translations(self):
        for lang in ("en", "de", "fr", "es", "it", "pt", "nl", "pl", "tr", "ru", "uk", "ar", "he", "hi", "bn",
                     "zh", "ja", "ko", "th"):
            self.assertIn(lang, pdf_typst._FOOTERS)
            self.assertIn("{page}", pdf_typst._FOOTERS[lang])
            self.assertIn("{total}", pdf_typst._FOOTERS[lang])
        # pdfium extracts RTL runs in visual order, so compare the letters used.
        footer = self._footer(render("مرحبا", locale="ar-SA"))[0]
        self.assertTrue(set("صفحةمن") <= set(footer), footer)
        self.assertEqual(footer.count("1"), 2)


@needs_render
class BrandingTests(unittest.TestCase):
    """6.2 hooks: logo on page 1, company name, accent colour, footer text."""

    def test_letterhead(self):
        branding = {"company_name": "Acme GmbH", "accent_color": "#1F6FEB",
                    "footer_text": "Acme GmbH · Confidential", "logo": _png((20, 90, 160), (240, 80))}
        r = render("# Report\n\n" + "Body text. " * 400, branding=branding)
        self.assertGreater(len(r.doc), 1)
        self.assertEqual(len(r.images(0)), 1)
        self.assertEqual(r.images(1), [])
        self.assertIn("Acme GmbH", r.text)
        for p in range(len(r.doc)):
            self.assertIn("Acme GmbH · Confidential", r.textpages[p].get_text_range())
        tp = r.textpages[0]
        k = tp.get_text_range().find("Report")
        rgba = [ctypes.c_uint() for _ in range(4)]
        pdfium_c.FPDFText_GetFillColor(tp.raw, k, *[ctypes.byref(v) for v in rgba])
        self.assertEqual(tuple(v.value for v in rgba[:3]), (0x1F, 0x6F, 0xEB))
        self.assertEqual(r.result.warnings.get("branding_invalid"), None)

    def test_invalid_branding_is_ignored(self):
        r = render("Body", branding={"accent_color": "red; evil", "logo": b"not an image", "company_name": 5})
        self.assertEqual(r.result.warnings.get("branding_invalid"), 2)
        self.assertEqual(r.images(0), [])
        self.assertIn("Body", r.text)


@needs_render
class DocumentStructureTests(unittest.TestCase):
    def test_tagged_with_lang_and_title(self):
        r = render("# Quarterly Report\n\n## Summary\n\nBody text.\n")
        self.assertTrue(pdfium_c.FPDFCatalog_IsTagged(r.doc.raw))
        self.assertEqual(r.lang(), "en")
        self.assertEqual(r.doc.get_metadata_dict().get("Title"), "Quarterly Report")

    def test_title_equal_to_the_first_h1_is_not_repeated(self):
        r = render(fixture("18_title_and_h1.md"), "Quarterly Report")
        top = [b.get_title() for b in r.doc.get_toc() if b.level == 0]
        self.assertEqual(top, ["Quarterly Report"])
        self.assertEqual(r.text.count("Quarterly Report"), 1)
        r2 = render(fixture("18_title_and_h1.md"), "Board pack")
        self.assertEqual([b.get_title() for b in r2.doc.get_toc() if b.level == 0], ["Board pack", "Quarterly Report"])
        self.assertEqual(r2.doc.get_metadata_dict().get("Title"), "Board pack")

    @staticmethod
    def _link_annotations(pdf: bytes) -> dict:
        """Link annotations as Typst writes them (uncompressed object dicts)."""
        uris = [u.decode("latin-1") for u in re.findall(rb"/S\s*/URI\s*/URI\s*\(([^)]*)\)", pdf)]
        internal = re.findall(rb"/Subtype\s*/Link[^>]*?/Dest\s*\(([^)]*)\)", pdf)
        return {"uris": uris, "internal": [d.decode("latin-1") for d in internal]}

    def test_links_anchors_footnotes_and_definition_lists(self):
        r = render_fixture("17_links.md")
        annots = self._link_annotations(r.result.pdf)
        self.assertEqual(annots["uris"], ["https://example.com/docs?x=1&y=2", "https://example.com/auto",
                                          "https://example.com/bare", "https://example.com/ref",
                                          "mailto:support@example.com"])
        self.assertEqual(annots["internal"], ["md-section-two"])  # '#section-two' heading anchor
        r2 = render_fixture("19_misc_markdown.md")
        self.assertIn("The footnote.", r2.text)
        self.assertIn("Definition", r2.text)
        self.assertIn("term", r2.text)
        r3 = render("A[^n] and B[^n].\n\n[^n]: Shared note.\n")
        self.assertEqual(r3.text.count("Shared note."), 1)  # one footnote, referenced twice

    def test_only_http_https_mailto_links(self):
        r = render("[a](ftp://example.com/x) [b](./local.md) [c](https://ok.example/) [d](#missing)")
        annots = self._link_annotations(r.result.pdf)
        self.assertEqual(annots["uris"], ["https://ok.example/"])
        self.assertEqual(r.result.warnings.get("link_dropped"), 3)

    def test_concurrent_renders(self):
        errors, results = [], []

        def work(i):
            try:
                results.append(pdf_typst.render_markdown_typst(f"# Doc {i}\n\nBody \\(x^{i}\\) ✅ مرحبا"))
            except Exception as e:  # pragma: no cover - surfaced below
                errors.append(repr(e))

        threads = [threading.Thread(target=work, args=(i,)) for i in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])
        self.assertEqual(len(results), 6)
        self.assertTrue(all(x.pdf.startswith(b"%PDF-") for x in results))

    def test_warnings_are_content_free_counts(self):
        r = render("Secret-payload-123 \\(\\foo\\) ![x](https://e.com/a.png) [a](ftp://x)")
        self.assertTrue(all(isinstance(k, str) and isinstance(v, int) for k, v in r.result.warnings.items()))
        self.assertNotIn("Secret", json.dumps(r.result.warnings))

    def test_temp_root_is_removed(self):
        before = set(os.listdir(tempfile.gettempdir()))
        pdf_typst.render_markdown_typst("# x\n\n![a](%s)" % _data_uri(_png((1, 2, 3))))
        leftovers = [n for n in set(os.listdir(tempfile.gettempdir())) - before if n.startswith("typst-render-")]
        self.assertEqual(leftovers, [])

    def test_selftest(self):
        pdf_typst.selftest()


class CoverageTests(unittest.TestCase):
    """Server-side helpers: no typst import, no font loads per call."""

    def test_import_is_cheap(self):
        code = ("import sys; import graph_tools.tools.pdf_typst as p; "
                "ok = p.fonts_cover({'a'}); print('typst' in sys.modules, 'PIL' in sys.modules)")
        out = subprocess.run([sys.executable, "-c", code], cwd=RETRIEVAL, capture_output=True, text=True, timeout=60)
        self.assertEqual(out.stdout.strip(), "False False", out.stderr[-400:])

    def test_coverage_json_is_committed_and_valid(self):
        path = os.path.join(pdf_typst.DEFAULT_FONT_DIR, pdf_typst.COVERAGE_FILENAME)
        with open(path, encoding="utf-8") as f:
            table = json.load(f)
        self.assertEqual(table["schema"], 1)
        with open(os.path.join(pdf_typst.DEFAULT_FONT_DIR, "fonts.lock.json"), encoding="utf-8") as f:
            lock = json.load(f)
        names = {e.get("dest") or os.path.basename(e["path"]) for p in lock["packages"] for e in p["files"]}
        self.assertEqual(set(table["fonts"]), names)
        ranges = table["ranges"]
        self.assertTrue(all(lo <= hi for lo, hi in ranges))
        self.assertTrue(all(a[1] + 1 < b[0] for a, b in zip(ranges, ranges[1:])))

    def test_fonts_cover(self):
        for text in ("Łódź Žluťoučký", "Ελληνικά Отчёт", "مرحبا", "שלום", "नमस्ते", "বাংলা", "ਪੰਜਾਬੀ", "ગુજરાતી",
                     "ଓଡ଼ିଆ", "தமிழ்", "తెలుగు", "ಕನ್ನಡ", "മലയാളം", "ไทย", "中文", "日本語ひらがなカタカナ", "한국어"):
            with self.subTest(text=text):
                self.assertTrue(pdf_typst.fonts_cover(set(text)))
        self.assertFalse(pdf_typst.fonts_cover({"\u1200"}))  # Ethiopic: no bundled font
        self.assertTrue(pdf_typst.fonts_cover(set("\u200d\ufe0f \t")))  # nothing to draw
        self.assertEqual(pdf_typst.bundled_script_coverage("Hello ሀ مرحبا"),
                         {"covered": ["Arabic", "Latin"], "uncovered": ["Ethiopic"]})

    def test_uncovered_characters_ignores_invisible_characters(self):
        self.assertEqual(pdf_typst.uncovered_characters("a\u200b\u200d\ufe0f\u00ad b\n"), set())
        self.assertEqual(pdf_typst.uncovered_characters("x \U00013000"), {"\U00013000"})

    def test_known_coverage_facts(self):
        # cross-checked with fontTools on the bundled set: U+0984 is unassigned in
        # Bengali fonts, arrows come from Noto Sans Math, emoji from the colour font
        self.assertEqual(pdf_typst.uncovered_characters("\u0984\u2192\U0001F680\u2611\u20b9"), {"\u0984"})

    @unittest.skipUnless(sys.platform.startswith("linux"), "glibc mallopt")
    def test_prepare_render_process_in_a_child(self):
        code = "import graph_tools.tools.pdf_typst as p; print(p.prepare_render_process())"
        out = subprocess.run([sys.executable, "-c", code], cwd=RETRIEVAL, capture_output=True, text=True, timeout=60)
        self.assertEqual(out.stdout.strip(), "True", out.stderr[-300:])

    @unittest.skipUnless(FONTS_PRESENT, SKIP_REASON)
    def test_coverage_json_matches_the_fonts_and_both_cmap_readers_agree(self):
        fetch_fonts = _load_script("fetch_fonts")
        with open(os.path.join(pdf_typst.DEFAULT_FONT_DIR, "fonts.lock.json"), encoding="utf-8") as f:
            lock = json.load(f)
        table = fetch_fonts.coverage_table(lock, pdf_typst.DEFAULT_FONT_DIR)
        with open(os.path.join(pdf_typst.DEFAULT_FONT_DIR, pdf_typst.COVERAGE_FILENAME), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["ranges"], table["ranges"])
        self.assertEqual([list(r) for r in pdf_typst.compute_coverage(pdf_typst.DEFAULT_FONT_DIR)], table["ranges"])
        self.assertEqual(fetch_fonts.check(lock, pdf_typst.DEFAULT_FONT_DIR, log=lambda *_: None), [])


class FetchFontsScriptTests(unittest.TestCase):
    """scripts/fetch_fonts.py against a local file:// registry (no network)."""

    def setUp(self):
        self.ff = _load_script("fetch_fonts")
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def _font_bytes(self) -> bytes:
        # A minimal sfnt with a cmap (format 4: 'A'..'C') plus a junk 'SVG ' table.
        import struct

        seg = 2
        cmap4 = struct.pack(">HHHHHHH", 4, 16 + seg * 8, 0, seg * 2, 2, 0, 0)
        cmap4 += struct.pack(">HH", 0x43, 0xFFFF) + b"\0\0" + struct.pack(">HH", 0x41, 0xFFFF)
        cmap4 += struct.pack(">hh", -0x40, 1) + struct.pack(">HH", 0, 0)
        cmap = struct.pack(">HHHHI", 0, 1, 3, 1, 12) + cmap4
        tables = {b"cmap": cmap, b"SVG ": b"x" * 64, b"head": b"\0" * 54}
        n = len(tables)
        out = struct.pack(">IHHHH", 0x00010000, n, 32, 1, n * 16 - 32)
        offset = 12 + 16 * n
        body = b""
        for tag in sorted(tables):
            data = tables[tag]
            out += struct.pack(">4sIII", tag, 0, offset + len(body), len(data))
            body += data + b"\0" * ((4 - len(data) % 4) % 4)
        return out + body

    def _registry(self, files: dict) -> dict:
        import base64
        import hashlib

        pkg_dir = os.path.join(self.tmp, "registry", "@test", "fonts", "-")
        os.makedirs(pkg_dir)
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tf:
            for name, data in files.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                tf.addfile(info, io.BytesIO(data))
        blob = buf.getvalue()
        with open(os.path.join(pkg_dir, "fonts-1.0.0.tgz"), "wb") as f:
            f.write(blob)
        return {"schema": 1, "registry": "file://" + os.path.join(self.tmp, "registry"),
                "packages": [{"name": "@test/fonts", "version": "1.0.0",
                              "integrity": "sha512-" + base64.b64encode(hashlib.sha512(blob).digest()).decode(),
                              "files": [{"path": "package/A.ttf",
                                         "sha256": hashlib.sha256(files["package/A.ttf"]).hexdigest()}]}]}

    def test_fetch_verify_and_coverage(self):
        font = self._font_bytes()
        lock = self._registry({"package/A.ttf": font, "package/evil.ttf": b"x", "../escape.txt": b"y"})
        dest = os.path.join(self.tmp, "fonts")
        self.assertEqual(self.ff.fetch(lock, dest, log=lambda *_: None), 1)
        self.assertEqual(sorted(os.listdir(dest)), ["A.ttf"])
        self.assertEqual(self.ff.fetch(lock, dest, log=lambda *_: None), 0)  # idempotent
        self.assertEqual(self.ff.check(lock, dest, log=lambda *_: None), [])
        self.assertTrue(self.ff.write_coverage(lock, dest))
        with open(os.path.join(dest, "coverage.json")) as f:
            self.assertEqual(json.load(f)["ranges"], [[0x41, 0x43]])
        self.assertEqual(pdf_typst.compute_coverage(dest), [(0x41, 0x43)])

    def test_tampered_tarball_or_member_is_refused(self):
        lock = self._registry({"package/A.ttf": self._font_bytes()})
        bad = json.loads(json.dumps(lock))
        bad["packages"][0]["integrity"] = "sha512-" + "A" * 86 + "=="
        with self.assertRaises(self.ff.FetchError):
            self.ff.fetch(bad, os.path.join(self.tmp, "f1"), log=lambda *_: None)
        bad = json.loads(json.dumps(lock))
        bad["packages"][0]["files"][0]["sha256"] = "0" * 64
        with self.assertRaises(self.ff.FetchError):
            self.ff.fetch(bad, os.path.join(self.tmp, "f2"), log=lambda *_: None)

    def test_drop_tables(self):
        import struct

        font = self._font_bytes()
        out = self.ff.drop_sfnt_tables(font, {"SVG "})
        num = struct.unpack(">H", out[4:6])[0]
        tags = [out[12 + 16 * i:16 + 16 * i] for i in range(num)]
        self.assertEqual(tags, [b"cmap", b"head"])
        total = sum(struct.unpack(">%dI" % (len(out) // 4), out + b"\0" * (-len(out) % 4))) & 0xFFFFFFFF
        self.assertEqual(total, 0xB1B0AFBA)  # head.checkSumAdjustment is consistent
        path = os.path.join(self.tmp, "x.ttf")
        with open(path, "wb") as f:
            f.write(out)
        self.assertEqual(self.ff.cmap_ranges(path), [(0x41, 0x43)])

    def test_lock_pins_every_font_with_integrity(self):
        with open(os.path.join(pdf_typst.DEFAULT_FONT_DIR, "fonts.lock.json"), encoding="utf-8") as f:
            lock = json.load(f)
        families = {p["name"].rsplit("/", 1)[1] for p in lock["packages"]}
        for fam in ("noto-sans", "noto-sans-mono", "noto-sans-symbols-2", "noto-sans-math", "noto-color-emoji",
                    "noto-sans-arabic", "noto-sans-hebrew", "noto-sans-devanagari", "noto-sans-bengali",
                    "noto-sans-gurmukhi", "noto-sans-gujarati", "noto-sans-oriya", "noto-sans-tamil",
                    "noto-sans-telugu", "noto-sans-kannada", "noto-sans-malayalam", "noto-sans-thai",
                    "noto-sans-sc", "noto-sans-jp", "noto-sans-kr"):
            self.assertIn(fam, families)
        for pkg in lock["packages"]:
            self.assertTrue(pkg["integrity"].startswith("sha512-"))
            for entry in pkg["files"]:
                self.assertRegex(entry["sha256"], r"^[0-9a-f]{64}$")


class VerifyMitexScriptTests(unittest.TestCase):
    def setUp(self):
        self.vm = _load_script("verify_mitex")

    def test_vendored_files_match_the_pins(self):
        self.assertEqual(self.vm.check_pins(), [])

    def test_upstream_comparison(self):
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tf:
            for rel in sorted(self.vm.PINNED):
                tf.add(os.path.join(self.vm.PACKAGE_DIR, rel), arcname=rel)
        self.assertEqual(self.vm.compare_upstream(buf.getvalue()), [])
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tf:
            for rel in sorted(self.vm.PINNED):
                data = b"tampered" if rel == "mitex.typ" else open(os.path.join(self.vm.PACKAGE_DIR, rel), "rb").read()
                info = tarfile.TarInfo(rel)
                info.size = len(data)
                tf.addfile(info, io.BytesIO(data))
        self.assertEqual(self.vm.compare_upstream(buf.getvalue()), ["differs from upstream: mitex.typ"])

    def test_unreachable_upstream_is_skipped(self):
        import contextlib

        with mock.patch.object(self.vm, "fetch_upstream", return_value=None), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(self.vm.main([]), 0)
            self.assertEqual(self.vm.main(["--require-upstream"]), 1)
        self.assertIn("upstream comparison skipped", out.getvalue())


_BIG_TABLE_CHILD = r"""
import json, resource, sys, time
sys.path.insert(0, sys.argv[1])
from graph_tools.tools import pdf_typst
pdf_typst.prepare_render_process()
md = sys.stdin.read()
t0 = time.process_time()
r = pdf_typst.render_markdown_typst(md)
cpu = time.process_time() - t0
peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
print(json.dumps({"cpu": cpu, "peak_mb": peak, "pages": r.pages, "ok": r.pdf.startswith(b"%PDF-")}))
"""


@needs_render
@unittest.skipUnless(sys.platform.startswith("linux"), "RLIMIT_AS bound is measured on Linux")
class BigTableBoundTests(unittest.TestCase):
    def test_2000_row_table_under_rlimit(self):
        """5.1: a 2,000-row table uses at most 3 CPU-s and at most 350 MB at the
        child peak under RLIMIT_AS 512 MB."""
        import resource

        def limit():
            resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))

        proc = subprocess.run([sys.executable, "-c", _BIG_TABLE_CHILD, RETRIEVAL], input=ledger_table(2000),
                              capture_output=True, text=True, preexec_fn=limit, timeout=300)
        self.assertEqual(proc.returncode, 0, proc.stderr[-500:])
        stats = json.loads(proc.stdout.strip().splitlines()[-1])
        self.assertTrue(stats["ok"])
        self.assertGreater(stats["pages"], 30)
        self.assertLessEqual(stats["cpu"], 3.0, stats)
        self.assertLessEqual(stats["peak_mb"], 350, stats)


class TemplateSafetyTests(unittest.TestCase):
    def test_template_never_evaluates_input(self):
        with open(pdf_typst.TEMPLATE_PATH, encoding="utf-8") as f:
            src = f.read()
        code = "\n".join(line for line in src.splitlines() if not line.lstrip().startswith("//"))
        self.assertNotRegex(code, r"\beval\(")
        self.assertNotRegex(code, r"\bread\(")
        self.assertEqual(re.findall(r'#import "([^"]+)"', code), ["@preview/mitex:0.2.7"])

    def test_graph_tools_contract(self):
        for name in ("pdf_typst.py", "pdf_markdown.py"):
            with open(os.path.join(RETRIEVAL, "graph_tools", "tools", name), encoding="utf-8") as f:
                src = f.read()
            self.assertNotRegex(src, r"(?m)^\s*(from|import)\s+(graph|routes|models|streaming|content_logging)\b")
            self.assertNotIn("logging", src)
            self.assertNotIn("print(", src.split('if __name__ == "__main__"')[0])


if __name__ == "__main__":
    unittest.main()
