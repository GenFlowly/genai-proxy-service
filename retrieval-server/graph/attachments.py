"""Uploaded documents (PDFs) for the model (plan 4.1).

The proxy sends references only (FileRef: attachment_id, s3_key, media_type,
filename, size_bytes, origin). This module resolves an uploaded PDF into what
the LLM node needs, without the server process ever parsing it:

- fetch_bytes: the object from the attachments bucket, through a small
  byte-bounded LRU of raw bytes, with a size bound and a '%PDF-' magic check;
- load: page count, whether it is encrypted, and each page's text. Parsing
  runs in the sandboxed worker child (graph/pdf_worker.parse_pdf, one heavy
  job at a time machine-wide); the result is cached as a sidecar object at
  '<s3_key>.derived/text-v1.json' tagged retention=derived (re-derivable,
  expired by the bucket's lifecycle rule). The sidecar key is built from the
  STORED s3_key, so a share recipient's read leaves it under the owner's
  prefix, where the owner's purge finds it. Extracted text never enters graph
  state or durable-run inputs;
- page_images: JPEG renders of chosen pages for scanned PDFs sent to vision
  models.

Logs carry ids, sizes and page counts only.
"""
import asyncio
import dataclasses
import json
import logging
import time
from dataclasses import dataclass, field

from graph import pdf_metrics, pdf_worker
from graph.s3_images import _ByteBoundedLRU

logger = logging.getLogger(__name__)

PDF_MEDIA_TYPE = "application/pdf"
PDF_MAGIC = b"%PDF-"
# The proxy refuses uploads over 10 MB; a little slack for what it measured.
MAX_PDF_BYTES = 11 * 1024 * 1024
SIDECAR_NAME = "text-v1.json"
# A page with fewer extractable characters than this counts as an image page;
# a document where at least half the pages are image pages is "scanned".
SCANNED_CHARS_PER_PAGE = 50

_BYTES = _ByteBoundedLRU(32 * 1024 * 1024)
# Parsed documents by stored key (keys never change content): every LLM call
# of a conversation (each turn, each tool round) replays its earlier
# documents, which would otherwise re-read the sidecar from S3 each time.
_DOCS = _ByteBoundedLRU(32 * 1024 * 1024)


class DocumentError(Exception):
    """A user-readable reason an uploaded document cannot be used (e.g. it
    is password-protected). On the current turn it fails the request with
    this message (streaming.py shows it verbatim); in history it degrades to
    a note."""


class _Unusable(Exception):
    """fetch_bytes: the object is not a usable PDF; args[0] is the status."""


@dataclass
class Document:
    attachment_id: str
    s3_key: str
    filename: str
    # ok | encrypted | unreadable | not_pdf | too_large | busy | error
    status: str = "ok"
    pages: int = 0
    page_chars: list = field(default_factory=list)
    texts: list = field(default_factory=list)

    @property
    def scanned(self) -> bool:
        if self.status != "ok" or not self.pages:
            return False
        sparse = sum(1 for c in self.page_chars if c < SCANNED_CHARS_PER_PAGE)
        sparse += max(0, self.pages - len(self.page_chars))
        return sparse * 2 >= self.pages

    def text(self, first: int = 0, last: int | None = None) -> str:
        """Pages first..last (0-based, inclusive) joined with page markers."""
        last = len(self.texts) - 1 if last is None else min(last, len(self.texts) - 1)
        parts = []
        for i in range(max(0, first), last + 1):
            body = (self.texts[i] or "").strip()
            parts.append(f"[page {i + 1}]\n{body}" if body else f"[page {i + 1}: no text]")
        return "\n\n".join(parts)


def sidecar_key(s3_key: str) -> str:
    return f"{s3_key}.derived/{SIDECAR_NAME}"


def is_pdf_ref(ref: dict) -> bool:
    return (ref.get("media_type") or "").split(";")[0].strip().lower() == PDF_MEDIA_TYPE


def _store():
    from graph.tools_runtime import _LazyAttachmentStore

    return _LazyAttachmentStore()


async def fetch_bytes(s3_key: str, store=None) -> bytes:
    """The PDF's bytes; raises _Unusable for an object that is not a PDF or
    is too large, KeyError when it does not exist."""
    cached = _BYTES.get(s3_key)
    if cached is not None:
        return cached[0]
    data = await asyncio.to_thread((store or _store()).get, s3_key)
    if len(data) > MAX_PDF_BYTES:
        raise _Unusable("too_large")
    if PDF_MAGIC not in data[:1024]:
        raise _Unusable("not_pdf")
    _BYTES.put(s3_key, data, len(data))
    return data


def _from_sidecar(ref: dict, raw: bytes) -> Document | None:
    try:
        doc = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(doc, dict) or doc.get("version") != 1:
        return None
    return Document(
        attachment_id=ref["attachment_id"], s3_key=ref["s3_key"],
        filename=ref.get("filename") or "document.pdf",
        status=str(doc.get("status") or "ok"), pages=int(doc.get("pages") or 0),
        page_chars=list(doc.get("page_chars") or []), texts=list(doc.get("texts") or []),
    )


async def load(ref: dict, store=None) -> Document:
    """Page count, encryption verdict and per-page text of an uploaded PDF,
    from its sidecar or parsed in the worker child (then cached)."""
    filename = ref.get("filename") or "document.pdf"
    cached_doc = _DOCS.get(ref["s3_key"])
    if cached_doc is not None:
        return dataclasses.replace(cached_doc[0], attachment_id=ref["attachment_id"], filename=filename)
    store = store or _store()
    doc = Document(attachment_id=ref["attachment_id"], s3_key=ref["s3_key"], filename=filename)
    try:
        raw = await asyncio.to_thread(store.get, sidecar_key(ref["s3_key"]))
    except KeyError:
        raw = None
    except Exception:
        logger.warning("Document sidecar read failed for attachment %s", ref["attachment_id"])
        raw = None
    if raw is not None:
        cached = _from_sidecar(ref, raw)
        if cached is not None:
            pdf_metrics.PDF_SIDECAR.labels(result="hit").inc()
            _remember(cached)
            return cached
    pdf_metrics.PDF_SIDECAR.labels(result="miss").inc()

    try:
        data = await fetch_bytes(ref["s3_key"], store)
    except _Unusable as e:
        doc.status = str(e.args[0])
        return doc
    except KeyError:
        doc.status = "unreadable"
        return doc
    except Exception:
        logger.warning("Document fetch failed for attachment %s", ref["attachment_id"])
        doc.status = "error"
        return doc

    started = time.perf_counter()
    header, payload = await pdf_worker.parse_pdf("inspect_extract", data)
    pdf_metrics.PDF_EXTRACT_SECONDS.observe(time.perf_counter() - started)
    status = header.get("status")
    if status != "ok":
        doc.status = header.get("kind") or "error"
        if doc.status not in ("encrypted", "unreadable"):
            return doc  # transient (busy, timeout, oom, error): not cached
    else:
        try:
            doc.texts = json.loads(payload.decode("utf-8")) if payload else []
        except (ValueError, UnicodeDecodeError):
            doc.status = "error"
            return doc
        doc.pages = int(header.get("pages") or 0)
        doc.page_chars = list(header.get("page_chars") or [])
        pdf_metrics.PDF_INPUT_PAGES.observe(doc.pages)
    logger.info(
        "Parsed attachment %s: status=%s pages=%d bytes=%d",
        ref["attachment_id"], doc.status, doc.pages, len(data),
    )
    await _write_sidecar(store, ref, doc)
    _remember(doc)
    return doc


def _remember(doc: Document) -> None:
    """Cache a parsed document whose verdict is final (ok, encrypted,
    unreadable); transient failures are retried on the next call."""
    if doc.status in ("ok", "encrypted", "unreadable"):
        _DOCS.put(doc.s3_key, doc, 1024 + sum(len(t) for t in doc.texts))


async def _write_sidecar(store, ref: dict, doc: Document) -> None:
    from graph.tools_runtime import DERIVED_TAGS

    body = json.dumps({
        "version": 1, "status": doc.status, "pages": doc.pages,
        "page_chars": doc.page_chars, "texts": doc.texts,
    }, ensure_ascii=False).encode("utf-8")
    try:
        await asyncio.to_thread(
            store.put, sidecar_key(ref["s3_key"]), body, "application/json",
            tags=dict(DERIVED_TAGS),
        )
    except Exception:
        logger.warning("Document sidecar write failed for attachment %s", ref["attachment_id"])


async def page_images(ref: dict, pages: list[int], max_edge: int = 1568, store=None) -> list[bytes]:
    """JPEG renders of the given 0-based pages (for scanned PDFs sent to
    vision models). Empty on any failure."""
    try:
        data = await fetch_bytes(ref["s3_key"], store)
    except Exception:
        return []
    header, payload = await pdf_worker.parse_pdf(
        "render_pages", data, {"pages": pages, "max_edge": max_edge}
    )
    if header.get("status") != "ok":
        return []
    images, offset = [], 0
    for n in header.get("image_lens") or []:
        images.append(payload[offset:offset + n])
        offset += n
    return images


def user_error(doc: Document) -> str:
    """The user-facing reason a current-turn document cannot be used."""
    name = doc.filename
    return {
        "encrypted": f"The PDF '{name}' is password-protected. Remove the password and attach it again.",
        "unreadable": f"The file '{name}' could not be read as a PDF. Check the file and attach it again.",
        "not_pdf": f"The file '{name}' is not a PDF.",
        "too_large": f"The PDF '{name}' is larger than 10 MB.",
    }.get(doc.status, f"The PDF '{name}' could not be read right now. Try again.")
