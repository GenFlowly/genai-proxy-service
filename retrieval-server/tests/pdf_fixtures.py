"""Small PDFs built in memory for the document tests (no binary fixtures).

Built with what the image already ships, not a PDF-writing library of their
own: pypdfium2 (pinned in requirements.txt) for pages with real text, drawn in
the standard Helvetica font through PDFium's page-object API, and Pillow's PDF
writer for scanned pages. The password-protected PDF uses pypdf
(requirements-dev.txt).
"""
import ctypes
import io

_LINE = "The quick brown fox jumps over the lazy dog, twice over."


def _add_text(pdf, page, text: str, x: float, y: float, size: float = 12) -> None:
    import pypdfium2.raw as pdfium_c

    obj = pdfium_c.FPDFPageObj_NewTextObj(pdf, b"Helvetica", size)
    buffer = ctypes.create_string_buffer((text + "\0").encode("utf-16-le"))
    pdfium_c.FPDFText_SetText(obj, ctypes.cast(buffer, pdfium_c.FPDF_WIDESTRING))
    pdfium_c.FPDFPageObj_Transform(obj, 1, 0, 0, 1, x, y)
    pdfium_c.FPDFPage_InsertObject(page, obj)  # the page owns it from here


def text_pdf(pages: int = 3, words: str = "text on page", lines: int = 1) -> bytes:
    """US Letter pages; page N starts with 'Page N <words> N.' followed by
    `lines` lines of filler, each line its own text object."""
    import pypdfium2 as pdfium
    import pypdfium2.raw as pdfium_c

    pdf = pdfium.PdfDocument.new()
    try:
        for i in range(pages):
            page = pdf.new_page(612, 792)
            _add_text(pdf, page, f"Page {i + 1} {words} {i + 1}.", 72, 720)
            for n in range(lines):
                _add_text(pdf, page, _LINE, 72, 700 - 14 * n)
            pdfium_c.FPDFPage_GenerateContent(page)
            page.close()
        out = io.BytesIO()
        pdf.save(out)
        return out.getvalue()
    finally:
        pdf.close()


def scanned_pdf(pages: int = 2) -> bytes:
    """Pages that carry only an image: no extractable text."""
    from PIL import Image

    image = Image.new("RGB", (612, 792), (240, 240, 240))
    for x in range(72, 540):
        image.putpixel((x, 396), (0, 0, 0))
    out = io.BytesIO()
    image.save(out, "PDF", resolution=72, save_all=True,
               append_images=[image.copy() for _ in range(pages - 1)])
    return out.getvalue()


def encrypted_pdf() -> bytes:
    from pypdf import PdfReader, PdfWriter

    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(text_pdf(1))))
    writer.encrypt("secret")
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


class MemoryStore:
    """ArtifactStore fake that records tags."""

    def __init__(self, objects: dict | None = None):
        self.objects: dict = dict(objects or {})
        self.tags: dict = {}

    def put(self, key, data, content_type, *, tags=None, filename=None):
        self.objects[key] = data
        self.tags[key] = tags

    def get(self, key):
        if key not in self.objects:
            raise KeyError(key)
        return self.objects[key]

    def list(self, prefix):
        return [{"key": k, "size": len(v)} for k, v in self.objects.items() if k.startswith(prefix)]
