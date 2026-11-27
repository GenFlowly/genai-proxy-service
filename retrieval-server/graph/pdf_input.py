"""Uploaded-PDF input: fetch from S3, then feed the model one of three ways.

The proxy sends only an S3 key (bytes stay in S3); this module resolves it at
LLM-call time. Which representation the model gets is decided by its
capabilities (graph/model_capabilities):

  * native  — models that read PDFs natively (Anthropic / capable OpenAI /
    Gemini) get a vendor document block carrying the raw PDF base64. No parsing
    on our side — the model does it.
  * pages   — non-native but vision-capable models get each page rendered to an
    image (pypdfium2) and sent through the existing image pipeline.
  * text    — text-only models get the extracted text (pdfplumber).

Parsing untrusted PDFs (render + text extraction) runs in a BOUNDED CHILD
PROCESS — a spawn with an address-space / CPU-time cap and a wall-clock timeout,
killed if it overruns — so a malicious or malformed PDF can at worst lose its
own child, never the shared 1-process server. The native path needs no parsing,
so it skips the child entirely.

Parser imports (pypdfium2, pdfplumber) are lazy, inside the child workers, so
this module imports cleanly even where those wheels aren't installed; only the
fallback paths need them.

Each form (raw base64, the data URL OpenAI takes, rendered pages, extracted
text) is prepared once per file and shared by every vendor of the turn through
the attachment cache, where it expires once idle: history turns don't re-send
documents.
"""
import base64
import logging
import multiprocessing as mp
import os
import queue as _queue
from concurrent.futures import ThreadPoolExecutor

from graph.attachment_cache import CACHE
from graph.image_normalize import ImageNormalizationError, limits_for_request

logger = logging.getLogger(__name__)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


# Hard ceiling on the bytes we'll pull from S3 — a little over the proxy's 10 MB
# upload cap so a legitimately-sized PDF is never rejected here on a rounding edge.
MAX_PDF_BYTES = _env_int("MAX_PDF_INPUT_BYTES", 12 * 1024 * 1024)
# Page-image fallback: cap pages so a 500-page PDF can't balloon the request.
PDF_MAX_RENDER_PAGES = _env_int("PDF_MAX_RENDER_PAGES", 30)
# Text fallback: per-document character budget (≈ a few thousand tokens).
PDF_MAX_EXTRACT_CHARS = _env_int("PDF_MAX_EXTRACT_CHARS", 60_000)
# Render DPI scale (1.0 ≈ 72 dpi); 2.0 ≈ 144 dpi reads cleanly without bloat.
PDF_RENDER_SCALE = _env_float("PDF_RENDER_SCALE", 2.0)
# Child-process guards.
PDF_PARSE_TIMEOUT_SEC = _env_float("PDF_PARSE_TIMEOUT_SEC", 25.0)
PDF_PARSE_MEM_MB = _env_int("PDF_PARSE_MEM_MB", 1024)
PDF_PARSE_CPU_SEC = _env_int("PDF_PARSE_CPU_SEC", 25)

# A clean child per render/extract — isolates the parse and avoids forking an
# asyncio process (which can inherit held locks).
_MP = mp.get_context("spawn")
# Renders and extractions wait on a child for up to PDF_PARSE_TIMEOUT_SEC, so
# they get their own threads rather than the image worker's.
_PARSE_POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix="attachment-parse")
# How long a prepared form outlives its last use: the vendors of one turn ask
# within seconds of each other, and a Regenerate shortly after.
_IDLE_TTL_S = 300


class PdfInputError(ImageNormalizationError):
    """A PDF could not be used as input (user-readable). Subclasses
    ImageNormalizationError so routes/retrieve + streaming surface it as an
    `attachment_error` with this message, exactly like an unusable image."""


# ── per-vendor native document blocks ───────────────────────────────────────

_NATIVE_FORMS = {"anthropic": "base64", "gemini": "base64", "openai": "data_url"}


def native_form(provider: str) -> str | None:
    """Which encoding of the PDF a provider's native document block carries:
    "base64", "data_url", or None when it has no known native form."""
    return _NATIVE_FORMS.get((provider or "").lower())


def native_block(provider: str, payload: str, filename: str | None) -> dict | None:
    """The content block carrying the raw PDF for a model that reads PDFs
    natively; `payload` is in native_form(provider). LangChain normalizes these
    into each vendor's wire shape. Returns None for a provider with no known
    native form (caller then falls back)."""
    p = (provider or "").lower()
    if p == "anthropic":
        return {
            "type": "document",
            "source": {"type": "base64", "media_type": "application/pdf", "data": payload},
        }
    if p == "openai":
        return {"type": "file", "file": {"filename": filename or "document.pdf", "file_data": payload}}
    if p == "gemini":
        return {"type": "media", "mime_type": "application/pdf", "data": payload}
    return None


# ── S3 fetch (bytes stay out of the subprocess boundary until needed) ────────

def _fetch_pdf_bytes_sync(s3_key: str) -> bytes:
    from graph import s3_images  # reuse the one boto3 client + ATTACHMENTS_BUCKET wiring

    bucket = os.environ.get("ATTACHMENTS_BUCKET", "")
    if not bucket:
        raise RuntimeError("ATTACHMENTS_BUCKET environment variable is not set")
    try:
        obj = s3_images._client().get_object(Bucket=bucket, Key=s3_key)
        size = obj.get("ContentLength")
        if size is not None and size > MAX_PDF_BYTES:
            raise PdfInputError("This PDF is too large to read (the limit is 10 MB).")
        data = obj["Body"].read()
    except PdfInputError:
        raise
    except Exception as e:
        code = getattr(e, "response", None) or {}
        code = code.get("Error", {}).get("Code") if isinstance(code, dict) else None
        if code in ("NoSuchKey", "404", "NotFound"):
            raise PdfInputError("An attached PDF is no longer available. Please attach it again.") from e
        logger.warning("Attachment PDF %s could not be read from S3: %s", s3_key, e)
        raise PdfInputError("An attached PDF could not be loaded right now. Please try again.") from e
    if len(data) > MAX_PDF_BYTES:
        raise PdfInputError("This PDF is too large to read (the limit is 10 MB).")
    return data


async def _shared(key, prepare, executor, cost=len):
    return await CACHE.get_or_prepare(key, prepare, executor, cost=cost, data_type="pdf", idle_ttl_s=_IDLE_TTL_S)


async def document_base64(s3_key: str) -> str:
    """The PDF's base64, fetched and encoded once for every vendor of the turn."""
    from graph import s3_images

    return await _shared(
        ("pdf-base64", s3_key),
        lambda: base64.b64encode(_fetch_pdf_bytes_sync(s3_key)).decode("ascii"),
        s3_images._IMAGE_POOL,
    )


async def document_data_url(s3_key: str) -> str:
    """`data:application/pdf;base64,...`, built once from document_base64."""
    from graph import s3_images

    b64 = await document_base64(s3_key)
    return await _shared(("pdf-data-url", s3_key), lambda: "data:application/pdf;base64," + b64, s3_images._IMAGE_POOL)


# ── bounded child process ────────────────────────────────────────────────────

def _set_limits() -> None:
    """Best-effort address-space + CPU caps for the child. Enforced on Linux
    (prod); a no-op where the platform refuses (some macOS dev setups)."""
    try:
        import resource
    except Exception:
        return
    for res_name, value in (("RLIMIT_AS", PDF_PARSE_MEM_MB * 1024 * 1024), ("RLIMIT_CPU", PDF_PARSE_CPU_SEC)):
        res = getattr(resource, res_name, None)
        if res is None:
            continue
        try:
            resource.setrlimit(res, (value, value))
        except (ValueError, OSError):
            pass


def _worker(q, op: str, pdf_bytes: bytes, kwargs: dict) -> None:
    """Child entrypoint (module-level for spawn picklability)."""
    try:
        _set_limits()
        if op == "text":
            q.put(("ok", _extract_text(pdf_bytes, kwargs["max_chars"])))
        elif op == "pages":
            q.put(("ok", _render_pages(
                pdf_bytes, kwargs["max_pages"], kwargs["scale"], kwargs["provider"], kwargs["other_images"],
            )))
        else:  # pragma: no cover - guarded by callers
            q.put(("err", f"unknown op {op}"))
    except BaseException as e:  # includes MemoryError from the rlimit
        q.put(("err", f"{type(e).__name__}: {e}"))


def _run_child(op: str, pdf_bytes: bytes, **kwargs):
    """Run one parse op in a capped child, returning its result or raising
    PdfInputError. Blocking — callers dispatch it to a thread."""
    q = _MP.Queue()
    p = _MP.Process(target=_worker, args=(q, op, pdf_bytes, kwargs), daemon=True)
    p.start()
    try:
        status, payload = q.get(timeout=PDF_PARSE_TIMEOUT_SEC)
    except _queue.Empty:
        logger.warning("PDF %s parse timed out / was killed (op=%s)", "<pdf>", op)
        raise PdfInputError("This PDF took too long to process. Try a smaller or simpler file.")
    finally:
        p.join(0.2)
        if p.is_alive():
            p.kill()
            p.join(0.5)
    if status == "err":
        logger.warning("PDF parse child failed (op=%s): %s", op, payload)
        raise PdfInputError("This PDF could not be read. It may be corrupt, encrypted, or unsupported.")
    return payload


def _extract_text(pdf_bytes: bytes, max_chars: int) -> dict:
    import io

    import pdfplumber

    parts: list[str] = []
    total = 0
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        page_count = len(pdf.pages)
        for page in pdf.pages:
            t = page.extract_text() or ""
            if t:
                parts.append(t)
                total += len(t)
            if total >= max_chars:
                break
    text = "\n\n".join(parts).strip()
    truncated = len(text) > max_chars
    return {"text": text[:max_chars], "truncated": truncated, "pages": page_count}


def _render_pages(pdf_bytes: bytes, max_pages: int, scale: float, provider: str, other_images: int) -> dict:
    """Pages as image data URLs. Each page is one more image of the request, so
    it gets a share of the vendor's request budget like any attachment."""
    import io

    import pypdfium2 as pdfium

    from graph import image_normalize

    pdf = pdfium.PdfDocument(pdf_bytes)
    try:
        total = len(pdf)
        rendered = min(total, max_pages)
        limits = limits_for_request(provider, other_images + rendered)
        out: list[str] = []
        for i in range(rendered):
            page = pdf[i]
            bitmap = page.render(scale=scale)
            pil = bitmap.to_pil().convert("RGB")
            buf = io.BytesIO()
            pil.save(buf, format="PNG")
            norm = image_normalize.normalize_image(
                buf.getvalue(), "image/png",
                passthrough_formats=limits.passthrough_formats,
                max_base64_bytes=limits.max_base64_bytes,
                max_edge=limits.max_edge,
            )
            out.append(f"data:{norm.media_type};base64," + base64.b64encode(norm.data).decode("ascii"))
        return {"pages": out, "total": total, "rendered": rendered}
    finally:
        pdf.close()


# ── public async API (one call per attached PDF) ─────────────────────────────

async def native_pdf_block(provider: str, s3_key: str, filename: str | None) -> dict:
    """A native document block for a PDF-capable model. Raises PdfInputError if
    the provider has no native form (shouldn't happen — gated on caps.pdf_input)."""
    form = native_form(provider)
    if form is None:
        raise PdfInputError("This model cannot read PDFs directly.")
    payload = await (document_data_url(s3_key) if form == "data_url" else document_base64(s3_key))
    return native_block(provider, payload, filename)


async def pdf_page_image_blocks(s3_key: str, provider: str, other_images: int = 0,
                                max_pages: int = PDF_MAX_RENDER_PAGES) -> list[dict]:
    """Each PDF page rendered to an image_url block (vision-model fallback),
    sharing the vendor's request budget with `other_images` attachments.
    Rendering + normalization run in the capped child."""
    def render():
        return _run_child(
            "pages", _fetch_pdf_bytes_sync(s3_key),
            max_pages=max_pages, scale=PDF_RENDER_SCALE,
            provider=(provider or "").lower(), other_images=other_images,
        )

    result = await _shared(
        ("pdf-pages", s3_key, (provider or "").lower(), other_images, max_pages), render, _PARSE_POOL,
        cost=lambda r: sum(len(u) for u in r["pages"]),
    )
    blocks = [{"type": "image_url", "image_url": {"url": url}} for url in result["pages"]]
    if result["total"] > result["rendered"]:
        blocks.append({"type": "text", "text":
                       f"[Showing the first {result['rendered']} of {result['total']} PDF pages.]"})
    if not blocks:
        raise PdfInputError("This PDF has no renderable pages.")
    return blocks


async def pdf_extracted_text(s3_key: str, filename: str | None,
                             max_chars: int = PDF_MAX_EXTRACT_CHARS) -> str:
    """Extracted text for a text-only model. Scanned/image-only PDFs yield no
    text — return an explicit note so the model can tell the user instead of
    silently seeing nothing."""
    result = await _shared(
        ("pdf-text", s3_key, max_chars),
        lambda: _run_child("text", _fetch_pdf_bytes_sync(s3_key), max_chars=max_chars),
        _PARSE_POOL,
        cost=lambda r: len(r["text"]),
    )
    name = filename or "document.pdf"
    text = result["text"]
    if not text:
        return (f"[Attached PDF: {name} — {result['pages']} page(s). No text could be "
                "extracted; it is likely a scanned/image PDF. To read it, select a "
                "vision-capable model.]")
    header = f"[Attached PDF: {name} — {result['pages']} page(s)]"
    if result["truncated"]:
        header += " [truncated to fit the context budget]"
    return f"{header}\n{text}"
