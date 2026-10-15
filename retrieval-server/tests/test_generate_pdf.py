"""
Unit tests for the generate_pdf tool and its x2p_v1 renderer.

Run with `python -m unittest tests.test_generate_pdf`.

Covers the PDF plan items that live in graph_tools/tools/generate_pdf.py and
pdf_charsets.py: the pinned dependency closure (1.2), renderer log records
kept out of the server's logs (1.4), input caps and table chunking (1.5),
raw HTML escaped except a small allowlist and no resource fetching (1.6), the
D8 list/table pre-pass (1.6), the honest-limits note (1.14) and titles,
filenames and emoji (2.7). Rendering runs in-process here (the tool falls
back to a thread when the host injects no runtime["render_pdf"]).
"""
import asyncio
import importlib.metadata
import io
import logging
import os
import re
import socket
import unittest
from unittest import mock

from graph_tools.base import ToolContext
from graph_tools.tools import generate_pdf as gp
from graph_tools.tools import pdf_charsets as pc

_APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _pdf_text(pdf: bytes) -> str:
    from pypdf import PdfReader

    return "\n".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(pdf)).pages)


class _MemoryStore:
    def __init__(self):
        self.objects: dict = {}

    def put(self, key, data, content_type, *, tags=None, filename=None):
        self.objects[key] = {
            "data": data, "content_type": content_type, "tags": tags, "filename": filename,
        }

    def get(self, key):
        return self.objects[key]["data"]


def _context(runtime: dict | None = None) -> tuple[ToolContext, _MemoryStore]:
    store = _MemoryStore()
    context = ToolContext(
        customer_id="cust-1",
        store=store,
        key_template="customers/{customer_id}/attachments/{artifact_id}",
        runtime=dict(runtime or {}),
        artifact_tags={"retention": "pending"},
    )
    return context, store


def _run(coro):
    return asyncio.run(coro)


# --- 1.2: the pinned closure ---------------------------------------------------


def _constraint_pins() -> dict:
    pins = {}
    with open(os.path.join(_APP_DIR, "constraints.txt")) as f:
        for line in f:
            line = line.split("#", 1)[0].strip()
            if "==" in line:
                name, version = line.split("==", 1)
                pins[name.strip().lower()] = version.strip()
    return pins


class DependencyPinTests(unittest.TestCase):
    def test_installed_renderer_closure_matches_the_constraints(self):
        pins = _constraint_pins()
        self.assertEqual(pins.get("xhtml2pdf"), "0.2.23")
        self.assertEqual(pins.get("reportlab"), "5.0.1")
        for name, version in pins.items():
            with self.subTest(package=name):
                self.assertEqual(importlib.metadata.version(name), version)

    def test_constraints_leave_shared_packages_to_the_app(self):
        # These are shared with the rest of the server (aiohttp: LangChain,
        # cryptography: credentials, pillow: images); pinning them for the PDF
        # closure would silently hold back security updates elsewhere.
        pins = _constraint_pins()
        for shared in ("aiohttp", "cryptography", "pillow", "six", "requests", "boto3", "urllib3"):
            self.assertNotIn(shared, pins)


# --- 1.14: what x2p_v1 can draw ------------------------------------------------


class CharsetTableTests(unittest.TestCase):
    def test_tables_match_reportlabs_codecs(self):
        from reportlab.pdfbase.rl_codecs import RL_Codecs

        RL_Codecs.register()

        def ranges(codec):
            out = []
            for cp in range(0x20, 0x10000):
                if cp == 0x7F or 0xD800 <= cp <= 0xDFFF:
                    continue
                try:
                    chr(cp).encode(codec)
                except (UnicodeEncodeError, ValueError):
                    continue
                if out and out[-1][1] == cp - 1:
                    out[-1][1] = cp
                else:
                    out.append([cp, cp])
            return [tuple(r) for r in out]

        self.assertEqual(ranges("winansi"), list(pc._WINANSI_RANGES))
        self.assertEqual(ranges("symbol"), list(pc._SYMBOL_RANGES))
        self.assertEqual(ranges("zapfdingbats"), list(pc._ZAPFDINGBATS_RANGES))

    def test_drawable_symbols_are_not_reported(self):
        found = pc.find_undrawable("α = 0.05 → ✓, ≤ 3 ∞ ★ café naïve €")
        self.assertEqual(found.scripts, {})
        self.assertEqual(found.symbols, 0)

    def test_accented_latin_outside_winansi_is_a_script(self):
        found = pc.find_undrawable("Łódź")
        self.assertEqual(found.scripts, {"Latin (accented)": 2})
        self.assertEqual(found.letters, {"Ł", "ź"})

    def test_emoji_and_their_parts_count_as_symbols(self):
        self.assertEqual(pc.find_undrawable("⚠️").symbols, 2)
        self.assertEqual(pc.find_undrawable("⚠️").scripts, {})
        # U+2011 non-breaking hyphens: punctuation, not a script.
        self.assertEqual(pc.find_undrawable("state‑of‑the‑art").symbols, 3)

    def test_scripts_are_named_and_marks_follow_their_letter(self):
        found = pc.find_undrawable("مرحبا שלום नमस्ते 你好")
        self.assertEqual(found.scripts["Arabic"], 5)
        self.assertEqual(found.scripts["Hebrew"], 4)
        # Virama and vowel sign count with the Devanagari letters.
        self.assertEqual(found.scripts["Devanagari (Hindi, Marathi, Nepali)"], 6)
        self.assertEqual(found.scripts["Chinese/Japanese (Han)"], 2)

    def test_spaces_and_controls_are_ignored(self):
        found = pc.find_undrawable("a b c　d\t\n")
        self.assertEqual((found.scripts, found.symbols), ({}, 0))

    def test_note_names_scripts_by_count(self):
        note = pc.unsupported_script_note(pc.find_undrawable("שלום مرحبا"))
        self.assertTrue(note.startswith("Note: this PDF contains Arabic and Hebrew text"))
        self.assertIn("offer to give the text in the chat instead", note)
        self.assertIsNone(pc.unsupported_script_note(pc.find_undrawable("⚠️ ok")))


# --- 1.6: D8 pre-pass ------------------------------------------------------------


class D8PrepassTests(unittest.TestCase):
    def assertUnchanged(self, text):
        self.assertEqual(gp.d8_prepass(text), text)

    def test_bullet_list_after_a_paragraph_line_gets_a_blank_line(self):
        self.assertEqual(gp.d8_prepass("Intro:\n- a\n- b"), "Intro:\n\n- a\n- b")
        self.assertEqual(gp.d8_prepass("Intro:\n* a"), "Intro:\n\n* a")

    def test_ordered_list_starting_at_one_gets_a_blank_line(self):
        self.assertEqual(gp.d8_prepass("Steps:\n1. one\n2. two"), "Steps:\n\n1. one\n2. two")
        self.assertEqual(gp.d8_prepass("Steps:\n1) one"), "Steps:\n\n1) one")

    def test_a_wrapped_number_stays_in_its_paragraph(self):
        # CommonMark: only an ordered item numbered 1 interrupts a paragraph.
        self.assertUnchanged("The company grew in\n2024. It was a good year.")
        self.assertUnchanged("Total\n2. something")

    def test_table_after_a_paragraph_line_gets_a_blank_line(self):
        text = "Here is the table:\n| a | b |\n|---|---|\n| 1 | 2 |"
        self.assertEqual(
            gp.d8_prepass(text), "Here is the table:\n\n| a | b |\n|---|---|\n| 1 | 2 |"
        )

    def test_a_pipe_line_without_a_delimiter_row_is_not_a_table(self):
        self.assertUnchanged("Text\n| not a table\nmore text")

    def test_code_is_never_touched(self):
        self.assertUnchanged("```\nIntro:\n- a\n```")
        self.assertUnchanged("~~~md\nIntro:\n| a |\n|---|\n~~~")
        self.assertUnchanged("Paragraph\n    - lazy continuation, not a list")

    def test_list_continuations_stay_in_the_list(self):
        self.assertUnchanged("- a\n  more\n- b")
        self.assertEqual(gp.d8_prepass("Intro\n- a\nlazy\n- b"), "Intro\n\n- a\nlazy\n- b")

    def test_setext_and_rules_are_left_alone(self):
        self.assertUnchanged("Heading\n---")
        self.assertUnchanged("Para\n***")
        self.assertUnchanged("Para\n\n- a")


# --- 1.6: raw HTML and the allowlist ---------------------------------------------


class MarkdownHtmlTests(unittest.TestCase):
    def _html(self, text):
        return gp._build_markdown().convert(gp.d8_prepass(text))

    def test_angle_bracket_placeholders_print_as_text(self):
        html = self._html("Dear <Candidate Name>,\n\nSee [Square Brackets].")
        self.assertIn("&lt;Candidate Name&gt;", html)
        self.assertIn("[Square Brackets]", html)

    def test_raw_tags_and_blocks_are_escaped(self):
        html = self._html('<img src="http://example.com/x.png">\n\n<div>\nhi\n</div>\n\n<style>p{}</style>')
        self.assertNotIn("<img", html)
        self.assertNotIn("<div", html)
        self.assertNotIn("<style", html)
        self.assertIn("&lt;img", html)

    def test_allowlisted_inline_tags_are_rebuilt(self):
        html = self._html("H<sub>2</sub>O, x<sup>2</sup>, <u>under</u>, a<br>b, c<br/>d")
        self.assertIn("<sub>2</sub>", html)
        self.assertIn("<sup>2</sup>", html)
        self.assertIn("<u>under</u>", html)
        self.assertEqual(html.count("<br"), 2)

    def test_allowlisted_tags_cannot_smuggle_attributes(self):
        html = self._html('<u onclick="x">a</u> <sub style="x">b</sub>')
        self.assertNotIn("<u ", html)
        self.assertNotIn("<sub ", html)

    def test_long_tables_are_split_into_chunks_repeating_the_header(self):
        rows = "\n".join(f"| r{i} | {i} |" for i in range(120))
        html = self._html(f"| name | n |\n|---|---|\n{rows}")
        self.assertEqual(html.count("<table"), 3)
        self.assertEqual(html.count("<thead>"), 3)
        for i in range(120):
            self.assertIn(f"<td>r{i}</td>", html)
        self.assertIn('class="pdf-chunk-nobottom"', html)
        self.assertIn('class="pdf-chunk-notop"', html)

    def test_short_tables_are_left_alone(self):
        html = self._html("| a |\n|---|\n| 1 |")
        self.assertEqual(html.count("<table"), 1)
        self.assertNotIn("pdf-chunk", html)

    def test_count_table_rows_skips_code_and_headers(self):
        text = (
            "| h |\n|---|\n| 1 |\n| 2 |\n\n"
            "```\n| h |\n|---|\n| x |\n```\n\n"
            "| h2 | h3 |\n| --- | --- |\n| 3 | 4 |\n"
        )
        self.assertEqual(gp.count_table_rows(text), 3)


# --- 2.7: filenames, titles, emoji ------------------------------------------------


class FilenameAndEmojiTests(unittest.TestCase):
    def test_sanitize_filename(self):
        cases = {
            "quarterly-report.pdf": "quarterly-report.pdf",
            "report.docx": "report.pdf",
            "report.PDF": "report.PDF",
            "report": "report.pdf",
            "  my   report  ": "my report.pdf",
            "Q3 report: final?.pdf": "Q3 report final.pdf",
            "../../etc/passwd": "etc-passwd.pdf",
            "résumé.pdf": "résumé.pdf",
            "": "document.pdf",
            None: "document.pdf",
            "???": "document.pdf",
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(gp._sanitize_filename(raw), expected)

    def test_long_names_keep_their_extension(self):
        name = gp._sanitize_filename("a" * 300 + ".pdf")
        self.assertTrue(name.endswith(".pdf"))
        self.assertEqual(len(name), 120)

    def test_status_emoji_map_to_drawable_symbols(self):
        self.assertEqual(gp.map_emoji_v1("Done ✅, failed ❌, ⭐ ✔️"), "Done ✓, failed ✗, ★ ✓")
        for ch in gp.map_emoji_v1("✅❌⭐⬆⬇➡⬅✔✖"):
            self.assertTrue(pc.x2p_can_draw(ch), hex(ord(ch)))
        self.assertEqual(gp.map_emoji_v1("plain"), "plain")


# --- rendering ----------------------------------------------------------------------


class RenderTests(unittest.TestCase):
    def test_renders_a_pdf_with_its_page_count(self):
        pdf, stats = gp.render_markdown_pdf("# Title\n\nSome text.", None, "a.pdf")
        self.assertTrue(pdf.startswith(b"%PDF"))
        self.assertEqual(stats["pages"], 1)
        # No warnings at all on plain text, border-collapse included (1.4).
        self.assertEqual(stats["warnings"], {})

    def test_placeholders_and_inline_tags_reach_the_pdf(self):
        pdf, _ = gp.render_markdown_pdf(
            "Dear <Candidate Name>, [Start Date]\n\nH<sub>2</sub>O and x<sup>2</sup> and <u>underlined</u>",
        )
        text = _pdf_text(pdf)
        self.assertIn("<Candidate Name>", text)
        self.assertIn("[Start Date]", text)
        self.assertIn("underlined", text)
        self.assertRegex(text, r"H\s*2\s*O")

    def test_line_breaks_in_table_cells_render(self):
        pdf, _ = gp.render_markdown_pdf("| a |\n|---|\n| first<br>second |")
        text = _pdf_text(pdf)
        self.assertIn("first", text)
        self.assertIn("second", text)
        self.assertNotIn("<br>", text)

    def test_never_opens_a_connection_for_images(self):
        attempts = []

        def refuse(*args, **kwargs):
            attempts.append(args)
            raise OSError("network disabled in test")

        with mock.patch.object(socket.socket, "connect", refuse), \
                mock.patch.object(socket, "getaddrinfo", refuse), \
                mock.patch.object(socket, "create_connection", refuse):
            pdf, stats = gp.render_markdown_pdf(
                "![logo](http://example.com/logo.png)\n\n![local](file:///etc/hostname)\n\ntext"
            )
        self.assertEqual(attempts, [])
        self.assertTrue(pdf.startswith(b"%PDF"))
        self.assertGreaterEqual(stats["warnings"].get("image", 0), 1)

    def test_title_is_not_printed_twice(self):
        pdf, _ = gp.render_markdown_pdf("# Quarterly Report\n\nBody text.", title="Quarterly  report")
        self.assertEqual(len(re.findall(r"Quarterly\s+Report", _pdf_text(pdf), re.I)), 1)

    def test_pdf_title_comes_from_the_first_h1_without_a_title(self):
        from pypdf import PdfReader

        pdf, _ = gp.render_markdown_pdf("Intro line.\n\n# Annual Review\n\nText.", None, "x.pdf")
        self.assertEqual(PdfReader(io.BytesIO(pdf)).metadata.title, "Annual Review")
        pdf, _ = gp.render_markdown_pdf("No headings here.", None, "my-notes.pdf")
        self.assertEqual(PdfReader(io.BytesIO(pdf)).metadata.title, "my-notes")
        pdf, _ = gp.render_markdown_pdf("# Body H1", "Given Title", "x.pdf")
        self.assertEqual(PdfReader(io.BytesIO(pdf)).metadata.title, "Given Title")

    def test_a_token_tree_failure_falls_back_and_is_counted(self):
        with mock.patch("graph_tools.tools.pdf_markdown.parse", side_effect=RuntimeError("boom")):
            pdf, stats = gp.render_markdown_pdf("# Heading\n\nText.", None, "x.pdf")
        self.assertTrue(pdf.startswith(b"%PDF"))
        self.assertEqual(stats["warnings"].get("title_parse_error"), 1)

    def test_title_is_added_when_the_content_has_none(self):
        pdf, _ = gp.render_markdown_pdf("Body text.", title="Offer Letter")
        self.assertIn("Offer Letter", _pdf_text(pdf))

    def test_renderer_records_never_reach_the_root_logger(self):
        records = []

        class _Capture(logging.Handler):
            def emit(self, record):
                records.append(record)

        root = logging.getLogger()
        capture = _Capture(logging.DEBUG)
        previous_level = root.level
        root.addHandler(capture)
        root.setLevel(logging.DEBUG)
        x2p = logging.getLogger("xhtml2pdf")
        before = (x2p.propagate, x2p.level, list(x2p.handlers))
        try:
            _, stats = gp.render_markdown_pdf("Secret 你好 مرحبا ⚠️ ![x](http://example.com/a.png)")
        finally:
            root.removeHandler(capture)
            root.setLevel(previous_level)
        self.assertGreater(stats["warnings"].get("missing_glyph", 0), 0)
        self.assertEqual([r.name for r in records if r.name.startswith("xhtml2pdf")], [])
        for record in records:
            self.assertNotIn("Secret", record.getMessage())
        self.assertEqual((x2p.propagate, x2p.level, list(x2p.handlers)), before)


class RenderJobTests(unittest.TestCase):
    def test_ok_shape(self):
        out = gp.render_job({"renderer": "x2p_v1", "markdown": "# Hi\n\ntext", "title": None,
                             "filename": "hi.pdf"})
        self.assertEqual(out["status"], "ok")
        self.assertTrue(out["pdf"].startswith(b"%PDF"))
        self.assertEqual(out["renderer"], "x2p_v1")
        self.assertEqual(out["pages"], 1)
        self.assertIn("render_cpu_seconds", out)

    def test_failures_map_to_kinds(self):
        job = {"renderer": "x2p_v1", "markdown": "x"}
        for raised, kind in (
            (gp.RenderError("render_limit"), "render_limit"),
            (MemoryError(), "oom"),
            # Out of memory under the child's address-space cap, measured.
            (SystemError("returned NULL without setting an exception"), "oom"),
            (RuntimeError("boom"), "error"),
        ):
            with self.subTest(kind=kind), mock.patch.object(gp, "render_markdown_pdf", side_effect=raised):
                self.assertEqual(gp.render_job(job), {"status": "error", "kind": kind})

    def test_typst_without_the_library_is_unsupported(self):
        with mock.patch.dict("sys.modules", {"graph_tools.tools.pdf_typst": None}):
            out = gp.render_job({"renderer": "typst", "markdown": "x"})
        self.assertEqual(out, {"status": "error", "kind": "unsupported"})


# --- 1.6 parity with the renderer before this plan --------------------------------

_FIXTURES = os.path.join(_APP_DIR, "tests", "fixtures", "pdf")
_BASELINES = os.path.join(_FIXTURES, "x2p_baseline")
# Fixtures whose text changes on purpose: the status-emoji map (2.7), raw
# HTML printed as text instead of interpreted (1.6), and lists/tables right
# after a paragraph line parsed as lists/tables (D8, 1.6). The targeted tests
# above assert those changes.
_INTENDED_CHANGES = {
    "09_emoji", "10_typography", "edge",
    "19_misc_markdown", "typst_syntax_prose",
    "22_llm_habits", "mixed",
}


def _pdfium_text(pdf: bytes) -> str:
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(pdf)
    try:
        pages = []
        for i in range(len(doc)):
            textpage = doc[i].get_textpage()
            pages.append(textpage.get_text_range())
            textpage.close()
        return "\f".join(pages).replace("\r\n", "\n")
    finally:
        doc.close()


class ParityTests(unittest.TestCase):
    """Every other fixture extracts exactly the text the unmodified renderer
    produced (tests/fixtures/pdf/x2p_baseline/, recorded from the code at the
    start of the PDF plan)."""

    def test_fixtures_extract_as_before(self):
        names = sorted(n[:-4] for n in os.listdir(_BASELINES) if n.endswith(".txt"))
        self.assertGreaterEqual(len(names), 25)
        checked = 0
        for name in names:
            if name in _INTENDED_CHANGES:
                continue
            with self.subTest(fixture=name):
                with open(os.path.join(_FIXTURES, f"{name}.md"), encoding="utf-8") as f:
                    markdown = f.read()
                with open(os.path.join(_BASELINES, f"{name}.txt"), encoding="utf-8", newline="") as f:
                    baseline = f.read().replace("\r\n", "\n")
                pdf, _ = gp.render_markdown_pdf(markdown)
                self.assertEqual(_pdfium_text(pdf), baseline)
                checked += 1
        self.assertGreaterEqual(checked, 20)


# --- the tool ---------------------------------------------------------------------


class GeneratePdfToolTests(unittest.TestCase):
    def test_saves_the_pdf_and_its_source_with_tags(self):
        context, store = _context()
        result = _run(gp.GeneratePdfTool().run(
            {"content_markdown": "# Plan\n\nText.", "filename": "plan.docx"}, context,
        ))
        self.assertEqual(len(result.artifacts), 1)
        artifact = result.artifacts[0]
        self.assertEqual(artifact.filename, "plan.pdf")
        self.assertEqual(artifact.page_count, 1)
        self.assertEqual(artifact.source_key, f"{artifact.key}.source.md")
        pdf = store.objects[artifact.key]
        self.assertTrue(pdf["data"].startswith(b"%PDF"))
        self.assertEqual(pdf["tags"], {"retention": "pending"})
        self.assertEqual(pdf["filename"], "plan.pdf")
        source = store.objects[artifact.source_key]
        self.assertEqual(source["data"].decode("utf-8"), "# Plan\n\nText.")
        self.assertEqual(source["tags"], {"retention": "pending"})
        self.assertEqual(source["filename"], "plan.md")
        self.assertIn("1 page", result.content)
        stats = result.details["pdf"]
        self.assertEqual(stats["status"], "ok")
        self.assertEqual(stats["renderer"], "x2p_v1")
        self.assertEqual(stats["input_chars"], len("# Plan\n\nText."))
        self.assertEqual(artifact.to_dict()["page_count"], 1)

    def test_stats_go_to_the_hosts_recorder_for_every_outcome(self):
        seen = []
        context, _ = _context({"record_pdf_stats": seen.append})
        _run(gp.GeneratePdfTool().run({"content_markdown": "text", "filename": "a.pdf"}, context))
        context, _ = _context({"record_pdf_stats": seen.append, "pdf_limits": {"x2p_v1": {"max_chars": 2}}})
        _run(gp.GeneratePdfTool().run({"content_markdown": "text", "filename": "a.pdf"}, context))

        async def busy(job):
            return {"status": "error", "kind": "busy"}

        context, _ = _context({"record_pdf_stats": seen.append, "render_pdf": busy})
        _run(gp.GeneratePdfTool().run({"content_markdown": "text", "filename": "a.pdf"}, context))
        self.assertEqual([s["status"] for s in seen], ["ok", "rejected", "busy"])

    def test_empty_content_is_an_error(self):
        context, store = _context()
        result = _run(gp.GeneratePdfTool().run({"content_markdown": "  ", "filename": "x"}, context))
        self.assertTrue(result.content.startswith("Error"))
        self.assertEqual(store.objects, {})

    def test_over_the_caps_nothing_is_rendered(self):
        async def never(job):
            raise AssertionError("must not render")

        for markdown, reason in (
            ("x" * (gp.DEFAULT_MAX_CHARS + 1), "chars"),
            ("| a |\n|---|\n" + "| 1 |\n" * (gp.DEFAULT_MAX_TABLE_ROWS + 1), "table_rows"),
        ):
            with self.subTest(reason=reason):
                context, store = _context({"render_pdf": never})
                result = _run(gp.GeneratePdfTool().run(
                    {"content_markdown": markdown, "filename": "big.pdf"}, context,
                ))
                self.assertIn("NOT created", result.content)
                self.assertEqual(result.details["pdf"]["status"], "rejected")
                self.assertEqual(result.details["pdf"]["reason"], reason)
                self.assertEqual(store.objects, {})

    def test_host_can_raise_the_caps_per_renderer(self):
        seen = []

        async def render(job):
            seen.append(job)
            return {"status": "ok", "pdf": b"%PDF-1.4 fake", "pages": 3, "warnings": {}}

        context, _ = _context({
            "render_pdf": render,
            "pdf_limits": {"x2p_v1": {"max_chars": 10}},
        })
        result = _run(gp.GeneratePdfTool().run(
            {"content_markdown": "x" * 11, "filename": "a.pdf"}, context,
        ))
        self.assertEqual(result.details["pdf"]["reason"], "chars")
        self.assertEqual(seen, [])

    def test_uses_the_hosts_renderer_and_maps_its_errors(self):
        for kind, status in (("busy", "busy"), ("oom", "oom"), ("timeout", "timeout"),
                             ("render_limit", "timeout"), ("weird", "error")):
            async def render(job, kind=kind):
                return {"status": "error", "kind": kind}

            with self.subTest(kind=kind):
                context, store = _context({"render_pdf": render})
                result = _run(gp.GeneratePdfTool().run(
                    {"content_markdown": "text", "filename": "a.pdf"}, context,
                ))
                self.assertTrue(result.content.startswith("Error"))
                self.assertIn("NOT created" if kind != "weird" else "no file", result.content)
                self.assertEqual(result.details["pdf"]["status"], status)
                self.assertEqual(result.artifacts, [])
                self.assertEqual(store.objects, {})

    def test_unsupported_script_note_on_x2p(self):
        context, _ = _context()
        result = _run(gp.GeneratePdfTool().run(
            {"content_markdown": "مرحبا بالعالم", "filename": "ar.pdf"}, context,
        ))
        self.assertIn("contains Arabic text", result.content)
        self.assertEqual(result.details["pdf"]["warnings"]["unsupported_script"], 12)

    def test_symbols_alone_get_no_note(self):
        context, _ = _context()
        result = _run(gp.GeneratePdfTool().run(
            {"content_markdown": "Careful ⚠️", "filename": "w.pdf"}, context,
        ))
        self.assertNotIn("Note:", result.content)
        self.assertEqual(result.details["pdf"]["warnings"]["unsupported_symbol"], 2)

    def test_script_route_sends_undrawable_letters_to_typst(self):
        jobs = []

        async def render(job):
            jobs.append(job)
            return {"status": "ok", "pdf": b"%PDF-1.7 fake", "pages": 1, "warnings": {},
                    "renderer": job["renderer"]}

        context, _ = _context({"render_pdf": render, "pdf_script_route": "typst"})
        result = _run(gp.GeneratePdfTool().run(
            {"content_markdown": "שלום", "filename": "he.pdf"}, context,
        ))
        self.assertEqual(jobs[-1]["renderer"], "typst")
        self.assertNotIn("Note:", result.content)
        self.assertEqual(result.details["pdf"]["renderer"], "typst")

        # Latin documents stay on the base renderer.
        _run(gp.GeneratePdfTool().run({"content_markdown": "Hello", "filename": "en.pdf"}, context))
        self.assertEqual(jobs[-1]["renderer"], "x2p_v1")

        # When the bundled fonts don't cover the letters, stay and say so.
        context, _ = _context({
            "render_pdf": render, "pdf_script_route": "typst", "pdf_fonts_cover": lambda letters: False,
        })
        result = _run(gp.GeneratePdfTool().run({"content_markdown": "שלום", "filename": "he.pdf"}, context))
        self.assertEqual(jobs[-1]["renderer"], "x2p_v1")
        self.assertIn("contains Hebrew text", result.content)

    def test_success_log_line_never_names_the_file(self):
        context, _ = _context()
        with self.assertLogs("graph_tools.tools.generate_pdf", level="INFO") as logs:
            _run(gp.GeneratePdfTool().run(
                {"content_markdown": "text", "filename": "Confidential Merger Plan.pdf"}, context,
            ))
        self.assertTrue(logs.output)
        for line in logs.output:
            self.assertNotIn("Confidential", line)


if __name__ == "__main__":
    unittest.main()
