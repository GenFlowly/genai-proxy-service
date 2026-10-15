"""
Unit tests for the generate_pdf tool. Typst is its only renderer since the
xhtml2pdf renderer ("x2p_v1") was removed (plan 5.2).

Run with `python -m unittest tests.test_generate_pdf`.

Covers what lives in graph_tools/tools/generate_pdf.py: the dependency files
after the removal (1.2, 5.2) and a server that loads nothing of the removed
renderer, input caps (1.5), raw HTML printed as text and no resource
fetching (1.6), lists and tables right after a paragraph line (D8), render
stats that carry no document text (1.4), titles and filenames (2.7),
render_job, and the tool itself: source sidecars, stats, errors and requests
still pinned to the removed renderer. Rendering runs in-process here (the
tool falls back to a thread when the host injects no runtime["render_pdf"]);
tests/test_pdf_typst.py covers the renderer itself.
"""
import asyncio
import io
import json
import logging
import os
import re
import socket
import subprocess
import sys
import unittest
from unittest import mock

from graph_tools.base import ToolContext
from graph_tools.tools import generate_pdf as gp
from graph_tools.tools import pdf_markdown, pdf_typst

_APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FONTS_PRESENT = bool(pdf_typst._font_files(pdf_typst.DEFAULT_FONT_DIR))
needs_fonts = unittest.skipUnless(
    FONTS_PRESENT, "bundled fonts missing: run `python scripts/fetch_fonts.py` in retrieval-server/"
)

# Every package that was installed only for the xhtml2pdf renderer (plan
# 5.2), with its top-level module.
REMOVED_PACKAGES = {
    "xhtml2pdf": "xhtml2pdf", "reportlab": "reportlab", "svglib": "svglib", "pyhanko": "pyhanko",
    "pyhanko-certvalidator": "pyhanko_certvalidator", "oscrypto": "oscrypto",
    "asn1crypto": "asn1crypto", "markdown": "markdown", "html5lib": "html5lib",
    "python-bidi": "bidi", "arabic-reshaper": "arabic_reshaper", "cssselect2": "cssselect2",
    "tinycss2": "tinycss2", "webencodings": "webencodings", "uritools": "uritools",
    "tzlocal": "tzlocal", "lxml": "lxml", "pypdf": "pypdf",
}


def _pdf_text(pdf: bytes) -> str:
    from pypdf import PdfReader

    return "\n".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(pdf)).pages)


def _pdf_metadata(pdf: bytes) -> dict:
    from pypdf import PdfReader

    return dict(PdfReader(io.BytesIO(pdf)).metadata or {})


def _made_by_typst(pdf: bytes) -> bool:
    return str(_pdf_metadata(pdf).get("/Creator", "")).startswith("Typst ")


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


def _render(markdown: str, title: str | None = None, renderer: str = "typst") -> dict:
    out = gp.render_job({"renderer": renderer, "markdown": markdown, "title": title})
    assert out["status"] == "ok", out
    return out


# --- 1.2 / 5.2: the dependency files and what the server loads ------------------


def _requirement_names(filename: str) -> dict:
    """{normalized name: exact version or None} of a requirements file."""
    names = {}
    with open(os.path.join(_APP_DIR, filename)) as f:
        for line in f:
            line = line.split("#", 1)[0].strip()
            if not line or line.startswith("-"):
                continue
            m = re.match(r"([A-Za-z0-9._-]+)(?:\[[^\]]*\])?\s*(==\s*([^\s;,]+))?", line)
            names[m.group(1).lower().replace("_", "-")] = m.group(3)
    return names


class DependencyTests(unittest.TestCase):
    def test_the_image_installs_nothing_of_the_removed_renderer(self):
        required = _requirement_names("requirements.txt")
        constraints = _requirement_names("constraints.txt")
        for name in REMOVED_PACKAGES:
            with self.subTest(package=name):
                self.assertNotIn(name, required)
                self.assertNotIn(name, constraints)

    def test_pypdf_is_a_test_only_pin(self):
        self.assertEqual(_requirement_names("requirements-dev.txt"), {"pypdf": "6.20.1"})

    def test_constraints_stay_a_file_without_shared_pins(self):
        # CI and the Dockerfile pass -c constraints.txt. Packages shared with
        # the rest of the server (aiohttp: LangChain, cryptography:
        # credentials, pillow: images) must never be pinned there: that would
        # silently hold back security updates elsewhere.
        constraints = _requirement_names("constraints.txt")
        for shared in ("aiohttp", "cryptography", "pillow", "six", "requests", "boto3", "urllib3"):
            self.assertNotIn(shared, constraints)

    def test_the_pdf_stack_is_pinned_and_installed_as_pinned(self):
        import importlib.metadata

        required = _requirement_names("requirements.txt")
        for name in ("typst", "markdown-it-py", "mdit-py-plugins", "mdurl", "linkify-it-py", "pypdfium2"):
            with self.subTest(package=name):
                self.assertIsNotNone(required.get(name), f"{name} must be pinned exactly")
                self.assertEqual(importlib.metadata.version(name), required[name])

    def test_server_and_render_load_nothing_of_the_removed_renderer(self):
        # A fresh interpreter (the test process may have imported anything):
        # the server app with every route and graph module, both kinds of
        # worker child's imports, one render through render_job (pinned to
        # the removed renderer, so the old code path would have loaded
        # xhtml2pdf) and one PDFium parse. The shared dev venv may still have
        # the old packages installed; none of them may be imported.
        # lxml is the exception: langchain_text_splitters imports it
        # optionally ("try: from lxml import etree") when it happens to be
        # installed, for HTML splitters this service never uses; the image no
        # longer installs it.
        banned = sorted(set(REMOVED_PACKAGES.values()) - {"lxml"})
        code = (
            "import sys\n"
            "import app, runs, routes.retrieve, routes.runs\n"
            "import graph.tools_runtime, graph.pdf_worker, graph.pdf_renderer, graph.pdf_metrics\n"
            "import graph.attachments, graph.documents, graph.attachment_tools, graph.nodes.llm_node\n"
            "from graph_tools.registry import *\n"
            "from graph_tools.tools import generate_pdf, revise_pdf\n"
            "from graph import pdf_render_child\n"
            "pdf_render_child._preload('typst')\n"
            "pdf_render_child._preload('parse')\n"
            "out = generate_pdf.render_job({'renderer': 'x2p_v1', 'markdown': '# Hi\\n\\n- a\\n', 'title': None})\n"
            "assert out['status'] == 'ok' and out['renderer'] == 'typst', out\n"
            "header, _ = pdf_render_child._parse('inspect_extract', out['pdf'], {})\n"
            "assert header['status'] == 'ok', header\n"
            f"banned = {banned!r}\n"
            "print('LOADED', sorted({m.split('.')[0] for m in sys.modules} & set(banned)))\n"
        )
        proc = subprocess.run([sys.executable, "-c", code], cwd=_APP_DIR, capture_output=True,
                              text=True, timeout=300)
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        loaded = [line for line in proc.stdout.splitlines() if line.startswith("LOADED ")]
        self.assertEqual(loaded, ["LOADED []"])


# --- render_job ------------------------------------------------------------------


class RenderJobTests(unittest.TestCase):
    @needs_fonts
    def test_ok_shape(self):
        out = gp.render_job({"renderer": "typst", "markdown": "# Hi\n\ntext", "title": None})
        self.assertEqual(out["status"], "ok")
        self.assertTrue(out["pdf"].startswith(b"%PDF"))
        self.assertTrue(_made_by_typst(out["pdf"]))
        self.assertEqual(out["renderer"], "typst")
        self.assertEqual(out["pages"], 1)
        self.assertEqual((out["missing_glyphs"], out["math_fallbacks"], out["images_dropped"]), (0, 0, 0))
        self.assertEqual(out["warnings"], {})
        self.assertIn("render_cpu_seconds", out)

    def test_the_removed_and_unknown_renderers_render_with_typst(self):
        for renderer in ("x2p_v1", "weasy", None):
            with self.subTest(renderer=renderer):
                out = gp.render_job({"renderer": renderer, "markdown": "# Hi\n\ntext", "title": None})
                self.assertEqual((out["status"], out["renderer"]), ("ok", "typst"))
                self.assertTrue(_made_by_typst(out["pdf"]))

    def test_failures_map_to_kinds(self):
        job = {"renderer": "typst", "markdown": "x"}

        def chained(*args, **kwargs):
            try:
                raise MemoryError()
            except MemoryError as e:
                raise RuntimeError("wrapped") from e

        for raised, kind in (
            (MemoryError(), "oom"),
            # Out of memory under the child's address-space cap: CPython can
            # report it as a SystemError when even raising MemoryError fails.
            (SystemError("returned NULL without setting an exception"), "oom"),
            (pdf_typst.TypstRenderError("typst compile failed"), "error"),
            (RuntimeError("boom"), "error"),
        ):
            with self.subTest(kind=kind, raised=type(raised).__name__), \
                    mock.patch.object(pdf_typst, "render_markdown_typst", side_effect=raised):
                self.assertEqual(gp.render_job(job), {"status": "error", "kind": kind})
        with mock.patch.object(pdf_typst, "render_markdown_typst", side_effect=chained):
            self.assertEqual(gp.render_job(job), {"status": "error", "kind": "oom"})

    def test_typst_without_the_library_is_unsupported(self):
        with mock.patch.dict("sys.modules", {"graph_tools.tools.pdf_typst": None}):
            out = gp.render_job({"renderer": "typst", "markdown": "x"})
        self.assertEqual(out, {"status": "error", "kind": "unsupported"})

    def test_options_reach_the_renderer(self):
        with mock.patch.object(pdf_typst, "render_markdown_typst",
                               wraps=pdf_typst.render_markdown_typst) as spy:
            out = gp.render_job({
                "renderer": "typst", "markdown": "text", "title": "T",
                "options": {"page_size": "Legal", "orientation": "landscape", "locale": "de-DE",
                            "branding": {"company_name": "Acme"}, "not_an_option": 1},
            })
        self.assertEqual(out["status"], "ok")
        options = spy.call_args.args[2]
        self.assertEqual((options.page_size, options.orientation, options.locale),
                         ("Legal", "landscape", "de-DE"))
        self.assertEqual(options.branding, {"company_name": "Acme"})


# --- rendering through Typst --------------------------------------------------------


class RenderTests(unittest.TestCase):
    def test_placeholders_and_inline_tags_reach_the_pdf(self):
        # 1.6: raw HTML prints as text ('Dear <Candidate Name>,' used to render
        # as 'Dear ,'); only <br>, <sub>, <sup> and <u> become structure.
        text = _pdf_text(_render(
            "Dear <Candidate Name>, [Start Date]\n\nH<sub>2</sub>O and x<sup>2</sup> and "
            "<u>underlined</u>\n\n<div>\nraw block\n</div>\n\n<style>p{}</style>"
        )["pdf"])
        self.assertIn("<Candidate Name>", text)
        self.assertIn("[Start Date]", text)
        self.assertIn("underlined", text)
        self.assertRegex(text, r"H\s*2\s*O")
        self.assertIn("<div>", text)
        self.assertIn("<style>p{}</style>", text)

    def test_line_breaks_in_table_cells_render(self):
        text = _pdf_text(_render("| a |\n|---|\n| first<br>second |")["pdf"])
        self.assertIn("first", text)
        self.assertIn("second", text)
        self.assertNotIn("<br>", text)

    def test_lists_and_tables_right_after_a_paragraph_line(self):
        # D8: the chat UI's CommonMark lets a list or table interrupt a
        # paragraph, and so does the PDF; a wrapped '2024.' stays text.
        markdown = (
            "Intro:\n- alpha\n- beta\n\nHere is the table:\n| col1 | col2 |\n|---|---|\n| one | two |\n\n"
            "The company grew in\n2024. It was a good year."
        )
        self.assertEqual([n["type"] for n in pdf_markdown.parse(markdown)["children"]],
                         ["paragraph", "bullet_list", "paragraph", "table", "paragraph"])
        text = _pdf_text(_render(markdown)["pdf"])
        self.assertRegex(text, r"•\s*alpha")
        self.assertNotIn("- alpha", text)
        self.assertNotIn("|", text)
        self.assertRegex(text, r"col1\s+col2\s+one\s+two")
        self.assertRegex(text, r"grew in\s+2024\.\s*It was a good year")

    def test_never_opens_a_connection_for_images(self):
        attempts = []

        def refuse(*args, **kwargs):
            attempts.append(args)
            raise OSError("network disabled in test")

        with mock.patch.object(socket.socket, "connect", refuse), \
                mock.patch.object(socket, "getaddrinfo", refuse), \
                mock.patch.object(socket, "create_connection", refuse):
            out = _render("![logo](http://example.com/logo.png)\n\n![local](file:///etc/hostname)\n\ntext")
        self.assertEqual(attempts, [])
        self.assertTrue(out["pdf"].startswith(b"%PDF"))
        self.assertGreaterEqual(out["warnings"].get("image_dropped", 0), 1)
        self.assertIn("[image: logo]", _pdf_text(out["pdf"]))

    def test_title_is_not_printed_twice(self):
        out = _render("# Quarterly Report\n\nBody text.", title="Quarterly  report")
        self.assertEqual(len(re.findall(r"Quarterly\s+Report", _pdf_text(out["pdf"]), re.I)), 1)

    def test_title_is_added_when_the_content_has_none(self):
        out = _render("Body text.", title="Offer Letter")
        self.assertIn("Offer Letter", _pdf_text(out["pdf"]))
        self.assertEqual(_pdf_metadata(out["pdf"]).get("/Title"), "Offer Letter")

    def test_pdf_title_is_the_title_else_the_first_h1(self):
        self.assertEqual(_pdf_metadata(_render("Intro line.\n\n# Annual Review\n\nText.")["pdf"]).get("/Title"),
                         "Annual Review")
        self.assertEqual(_pdf_metadata(_render("# Body H1", "Given Title")["pdf"]).get("/Title"),
                         "Given Title")


# --- 1.5: the table-row cap ---------------------------------------------------------


class CountTableRowsTests(unittest.TestCase):
    def test_skips_code_and_headers(self):
        text = (
            "| h |\n|---|\n| 1 |\n| 2 |\n\n"
            "```\n| h |\n|---|\n| x |\n```\n\n"
            "| h2 | h3 |\n| --- | --- |\n| 3 | 4 |\n"
        )
        self.assertEqual(gp.count_table_rows(text), 3)

    def test_counts_what_the_token_tree_holds(self):
        # The cap is a cheap line scan in the server process; Typst renders
        # pdf_markdown's tree. For the tables models write they agree.
        docs = {
            "simple": "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n",
            "after a paragraph line": "Here is the table:\n| a | b |\n|---|---|\n| 1 | 2 |\n",
            "aligned": "| a | b |\n|:---|---:|\n| 1 | 2 |\n",
            "no outer pipes": "a | b\n--- | ---\n1 | 2\n3 | 4\n",
            "fenced": "```\n| h |\n|---|\n| x |\n```\n",
            "two tables": "| h |\n|---|\n| 1 |\n\ntext\n\n| h2 | h3 |\n| --- | --- |\n| 3 | 4 |\n| 5 | 6 |\n",
            "in a list item": "- item\n\n  | h |\n  |---|\n  | 1 |\n",
            "over the cap": "| a |\n|---|\n" + "| 1 |\n" * (gp.DEFAULT_MAX_TABLE_ROWS + 1),
        }
        for name, text in docs.items():
            with self.subTest(doc=name):
                self.assertEqual(gp.count_table_rows(text),
                                 pdf_markdown.count_table_rows(pdf_markdown.parse(text)))


# --- 2.7: filenames ----------------------------------------------------------------


class FilenameTests(unittest.TestCase):
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


# --- the tool ---------------------------------------------------------------------


class RenderOptionsTests(unittest.TestCase):
    """6.1 locale and 6.2 letterhead settings reach the render job; the logo
    comes only from the graph owner's prefix."""

    PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32

    def _render(self, runtime: dict, args: dict | None = None):
        jobs = []

        async def render(job):
            jobs.append(job)
            return {"status": "ok", "pdf": b"%PDF-1.7\n%%EOF", "pages": 1, "warnings": {}}

        seen = []
        context, store = _context({"pdf_renderer": "typst", "render_pdf": render,
                                   "record_pdf_stats": seen.append, **runtime})
        return context, store, jobs, seen, render

    def _go(self, context, args=None):
        return _run(gp.GeneratePdfTool().run(
            {"content_markdown": "# Report\n\nText.", "filename": "r.pdf", **(args or {})}, context,
        ))

    def test_locale_page_size_and_branding_reach_the_job(self):
        context, _, jobs, seen, _ = self._render({
            "locale": "de-DE",
            "pdf_settings": {"default_page_size": "Letter", "company_name": "Acme GmbH",
                             "footer_text": "Vertraulich", "accent_color": "#1A2b3C"},
        })
        self._go(context)
        options = jobs[0]["options"]
        self.assertEqual(options["locale"], "de-DE")
        self.assertEqual(options["page_size"], "Letter")
        self.assertEqual(options["branding"], {"company_name": "Acme GmbH",
                                               "footer_text": "Vertraulich",
                                               "accent_color": "#1A2b3C"})
        # The model's explicit page size beats the configured default.
        context, _, jobs, _, _ = self._render({"pdf_settings": {"default_page_size": "Letter"}})
        self._go(context, {"page_size": "A4"})
        self.assertEqual(jobs[0]["options"]["page_size"], "A4")

    def test_malformed_settings_are_dropped(self):
        context, _, jobs, _, _ = self._render({
            "locale": "de-DE; rm",
            "pdf_settings": {"default_page_size": "Tabloid", "accent_color": "red; x"},
        })
        self._go(context)
        self.assertEqual(jobs[0]["options"], {})

    def test_logo_is_read_from_the_graph_owners_prefix(self):
        context, store, jobs, seen, _ = self._render({
            "pdf_settings": {"logo_attachment_id": "logo-0001"},
            "pdf_settings_owner": "System",
        })
        store.put("customers/System/attachments/logo-0001", self.PNG, "image/png")
        self._go(context)
        branding = jobs[0]["options"]["branding"]
        self.assertEqual(gp.base64.b64decode(branding["logo_b64"]), self.PNG)
        self.assertNotIn("branding_logo_unavailable", seen[0].get("warnings") or {})

    def test_without_an_owner_the_requesting_customer_owns_the_logo(self):
        context, store, jobs, _, _ = self._render({"pdf_settings": {"logo_attachment_id": "logo-0001"}})
        store.put("customers/cust-1/attachments/logo-0001", self.PNG, "image/png")
        self._go(context)
        self.assertIn("logo_b64", jobs[0]["options"]["branding"])

    def test_a_fork_of_a_system_agent_keeps_the_system_logo(self):
        # A customer's edit forks a System agent; the copied config still
        # names the admin-uploaded logo, which lives under System's prefix.
        context, store, jobs, _, _ = self._render({
            "pdf_settings": {"logo_attachment_id": "logo-0001"},
            "pdf_settings_owner": "cust-1",
        })
        store.put("customers/System/attachments/logo-0001", self.PNG, "image/png")
        self._go(context)
        self.assertIn("logo_b64", jobs[0]["options"]["branding"])

    def test_another_customers_logo_is_refused_and_counted(self):
        # The id exists, but under a different customer: the PDF renders
        # without it and the warning is counted.
        context, store, jobs, seen, _ = self._render({
            "pdf_settings": {"logo_attachment_id": "logo-0001", "company_name": "Acme"},
            "pdf_settings_owner": "cust-1",
        })
        store.put("customers/cust-2/attachments/logo-0001", self.PNG, "image/png")
        result = self._go(context)
        self.assertEqual(len(result.artifacts), 1)
        self.assertNotIn("logo_b64", jobs[0]["options"]["branding"])
        self.assertEqual(seen[0]["warnings"]["branding_logo_unavailable"], 1)

    def test_a_malformed_owner_or_id_is_refused(self):
        for runtime in ({"pdf_settings": {"logo_attachment_id": "logo-0001"}, "pdf_settings_owner": "../cust-2"},
                        {"pdf_settings": {"logo_attachment_id": "../../x/logo"}}):
            context, store, jobs, seen, _ = self._render(runtime)
            store.put("customers/cust-2/attachments/logo-0001", self.PNG, "image/png")
            self._go(context)
            self.assertNotIn("branding", jobs[0]["options"])
            self.assertEqual(seen[0]["warnings"]["branding_logo_unavailable"], 1)

    def test_typst_draws_the_owners_logo_on_page_one(self):
        from PIL import Image

        buf = io.BytesIO()
        Image.new("RGB", (240, 80), (20, 90, 160)).save(buf, "PNG")
        context, store = _context({"pdf_renderer": "typst",
                                   "pdf_settings": {"logo_attachment_id": "logo-0001",
                                                    "company_name": "Acme"},
                                   "pdf_settings_owner": "System"})
        store.put("customers/System/attachments/logo-0001", buf.getvalue(), "image/png")
        result = _run(gp.GeneratePdfTool().run(
            {"content_markdown": "# Report\n\nText.", "filename": "r.pdf"}, context,
        ))
        self.assertEqual(result.details["pdf"]["status"], "ok", result.content)
        from pypdf import PdfReader

        page = PdfReader(io.BytesIO(store.objects[result.artifacts[0].key]["data"])).pages[0]
        xobjects = page["/Resources"].get("/XObject") or {}
        self.assertTrue(any(x.get_object().get("/Subtype") == "/Image" for x in xobjects.values()))

    def test_a_request_pinned_to_the_removed_renderer_gets_the_settings_too(self):
        # x2p_v1 ignored locale and letterhead; a request still pinned to it
        # renders with Typst (plan 5.2), which applies them.
        context, store, jobs, seen, _ = self._render({
            "pdf_renderer": "x2p_v1", "locale": "en-US",
            "pdf_settings": {"logo_attachment_id": "logo-0001", "company_name": "Acme"},
        })
        store.put("customers/cust-1/attachments/logo-0001", self.PNG, "image/png")
        self._go(context)
        self.assertEqual(jobs[0]["renderer"], "typst")
        options = jobs[0]["options"]
        self.assertEqual(options["locale"], "en-US")
        self.assertEqual(options["branding"]["company_name"], "Acme")
        self.assertEqual(gp.base64.b64decode(options["branding"]["logo_b64"]), self.PNG)
        self.assertEqual(seen[0]["renderer"], "typst")


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
        self.assertTrue(_made_by_typst(pdf["data"]))
        self.assertEqual(pdf["tags"], {"retention": "pending"})
        self.assertEqual(pdf["filename"], "plan.pdf")
        source = store.objects[artifact.source_key]
        self.assertEqual(source["data"].decode("utf-8"), "# Plan\n\nText.")
        self.assertEqual(source["tags"], {"retention": "pending"})
        self.assertEqual(source["filename"], "plan.md")
        self.assertIn("1 page", result.content)
        stats = result.details["pdf"]
        self.assertEqual(stats["status"], "ok")
        self.assertEqual(stats["renderer"], "typst")
        self.assertEqual(stats["input_chars"], len("# Plan\n\nText."))
        self.assertEqual(artifact.to_dict()["page_count"], 1)

    def test_a_request_pinned_to_the_removed_renderer_renders_with_typst(self):
        # Plan 5.2: a durable run enqueued before the removal deploy is
        # recovered with its pinned renderer ("x2p_v1") and the script-route
        # fields of that time; it renders with Typst instead of failing.
        jobs = []

        def render(job):
            jobs.append(job)
            return gp.render_job(job)

        async def host_render(job):
            return await asyncio.to_thread(render, job)

        context, store = _context({
            "render_pdf": host_render, "pdf_renderer": "x2p_v1", "pdf_script_route": "typst",
            "pdf_fonts_cover": lambda letters: False,
            "pdf_limits": {"x2p_v1": {"max_chars": 5}},  # a stale entry is not applied
        })
        result = _run(gp.GeneratePdfTool().run(
            {"content_markdown": "مرحبا بالعالم and Łódź", "filename": "ar.pdf"}, context,
        ))
        self.assertEqual(len(result.artifacts), 1, result.content)
        self.assertEqual(jobs[0]["renderer"], "typst")
        self.assertTrue(_made_by_typst(store.objects[result.artifacts[0].key]["data"]))
        self.assertEqual(result.details["pdf"]["renderer"], "typst")
        self.assertNotIn("Note:", result.content)

    @needs_fonts
    def test_every_script_renders_without_an_honest_limits_note(self):
        # The 1.14 note and the unsupported_script/unsupported_symbol counts
        # were x2p_v1's; Typst draws these with the bundled fonts.
        context, _ = _context()
        result = _run(gp.GeneratePdfTool().run(
            {"content_markdown": "مرحبا بالعالم שלום नमस्ते 你好 Łódź ⚠️ ✅", "filename": "s.pdf"}, context,
        ))
        self.assertEqual(len(result.artifacts), 1, result.content)
        self.assertNotIn("Note:", result.content)
        warnings = result.details["pdf"]["warnings"]
        for kind in ("unsupported_script", "unsupported_symbol", "missing_glyph"):
            self.assertNotIn(kind, warnings)

    def test_stats_go_to_the_hosts_recorder_for_every_outcome(self):
        seen = []
        context, _ = _context({"record_pdf_stats": seen.append})
        _run(gp.GeneratePdfTool().run({"content_markdown": "text", "filename": "a.pdf"}, context))
        context, _ = _context({"record_pdf_stats": seen.append, "pdf_limits": {"typst": {"max_chars": 2}}})
        _run(gp.GeneratePdfTool().run({"content_markdown": "text", "filename": "a.pdf"}, context))

        async def busy(job):
            return {"status": "error", "kind": "busy"}

        context, _ = _context({"record_pdf_stats": seen.append, "render_pdf": busy})
        _run(gp.GeneratePdfTool().run({"content_markdown": "text", "filename": "a.pdf"}, context))
        self.assertEqual([s["status"] for s in seen], ["ok", "rejected", "busy"])
        self.assertEqual({s["renderer"] for s in seen}, {"typst"})

    def test_stats_never_carry_document_text(self):
        # 1.4, on Typst: the render's warnings (a glyph no bundled font has,
        # a remote image) are counts; no log record and no stat holds text.
        records = []

        class _Capture(logging.Handler):
            def emit(self, record):
                records.append(record)

        seen = []
        context, _ = _context({"record_pdf_stats": seen.append})
        root = logging.getLogger()
        capture = _Capture(logging.DEBUG)
        previous_level = root.level
        root.addHandler(capture)
        root.setLevel(logging.DEBUG)
        try:
            result = _run(gp.GeneratePdfTool().run({
                "content_markdown": "Secret-payload-123 ሰላም ![x](http://example.com/a.png)",
                "filename": "Secret-payload-123.pdf",
            }, context))
        finally:
            root.removeHandler(capture)
            root.setLevel(previous_level)
        self.assertEqual(len(result.artifacts), 1, result.content)
        warnings = result.details["pdf"]["warnings"]
        self.assertGreater(warnings.get("missing_glyph", 0), 0)  # Ethiopic: no bundled font
        self.assertGreater(warnings.get("image_dropped", 0), 0)
        self.assertNotIn("Secret", json.dumps(seen))
        for record in records:
            self.assertNotIn("Secret", record.getMessage())

    def test_empty_content_is_an_error(self):
        context, store = _context()
        result = _run(gp.GeneratePdfTool().run({"content_markdown": "  ", "filename": "x"}, context))
        self.assertTrue(result.content.startswith("Error"))
        self.assertEqual(store.objects, {})
        self.assertEqual(result.details["pdf"], {"status": "error", "renderer": "typst"})

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

    def test_host_sets_the_caps(self):
        seen = []

        async def render(job):
            seen.append(job)
            return {"status": "ok", "pdf": b"%PDF-1.7 fake", "pages": 3, "warnings": {}}

        context, _ = _context({"render_pdf": render, "pdf_limits": {"typst": {"max_chars": 10}}})
        result = _run(gp.GeneratePdfTool().run({"content_markdown": "x" * 11, "filename": "a.pdf"}, context))
        self.assertEqual(result.details["pdf"]["reason"], "chars")
        self.assertEqual(seen, [])

        # Raised caps (5.2, after calibration) let larger documents through.
        context, _ = _context({"render_pdf": render, "pdf_limits": {
            "typst": {"max_chars": 300_000, "max_table_rows": 2_500}}})
        rows = "| a |\n|---|\n" + "| 1 |\n" * 2_000
        result = _run(gp.GeneratePdfTool().run({"content_markdown": rows, "filename": "a.pdf"}, context))
        self.assertEqual(result.details["pdf"]["status"], "ok")
        self.assertEqual(len(seen), 1)

    def test_page_options_reach_the_job(self):
        jobs = []

        async def render(job):
            jobs.append(job)
            return {"status": "ok", "pdf": b"%PDF-1.7 fake", "pages": 1, "warnings": {}}

        context, _ = _context({"render_pdf": render, "locale": "en-US",
                               "pdf_settings": {"default_page_size": "Letter"}})
        _run(gp.GeneratePdfTool().run({"content_markdown": "x", "filename": "a.pdf"}, context))
        _run(gp.GeneratePdfTool().run({"content_markdown": "x", "filename": "a.pdf", "page_size": "Legal",
                                       "orientation": "landscape"}, context))
        _run(gp.GeneratePdfTool().run({"content_markdown": "x", "filename": "a.pdf", "page_size": "B5",
                                       "orientation": "sideways"}, context))
        self.assertEqual([j["options"] for j in jobs], [
            {"locale": "en-US", "page_size": "Letter"},
            {"locale": "en-US", "page_size": "Legal", "orientation": "landscape"},
            {"locale": "en-US", "page_size": "Letter"},
        ])
        self.assertEqual({j["renderer"] for j in jobs}, {"typst"})
        self.assertTrue(all("filename" not in j for j in jobs))

    def test_uses_the_hosts_renderer_and_maps_its_errors(self):
        for kind, status in (("busy", "busy"), ("oom", "oom"), ("timeout", "timeout"),
                             ("unsupported", "error"), ("weird", "error")):
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
