"""Small PDFs built in memory for the document tests (no binary fixtures)."""
import io


def text_pdf(pages: int = 3, words: str = "text on page", lines: int = 1) -> bytes:
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    for i in range(pages):
        c.drawString(72, 720, f"Page {i + 1} {words} {i + 1}.")
        for n in range(lines):
            c.drawString(72, 700 - 14 * n, "The quick brown fox jumps over the lazy dog, twice over.")
        c.showPage()
    c.save()
    return buf.getvalue()


def scanned_pdf(pages: int = 2) -> bytes:
    """Pages that carry only an image: no extractable text."""
    from PIL import Image
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas

    image = Image.new("RGB", (200, 100), (240, 240, 240))
    for x in range(20, 180):
        image.putpixel((x, 50), (0, 0, 0))
    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    for _ in range(pages):
        c.drawImage(ImageReader(image), 72, 500, width=400, height=200)
        c.showPage()
    c.save()
    return buf.getvalue()


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
