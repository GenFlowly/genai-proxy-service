"""How uploaded documents reach the model (plans 4.1 and 4.2).

On the turn a PDF is attached (including that turn's tool rounds):
- a model that reads PDFs natively (graph/capabilities.py) gets a LangChain
  standard file block, which becomes an Anthropic document, an OpenAI Chat
  file, an OpenAI Responses input_file or Gemini inline_data. Native PDFs
  are capped at MAX_NATIVE_PAGES pages and draw from the request's
  attachment byte budget, shared with images;
- otherwise the extracted text, in a <document> block;
- a scanned PDF (at least half its pages without text) becomes page images
  for vision models, or an explicit note for text-only ones;
- an encrypted or unreadable PDF fails the turn with a user-facing message;
- when parsing is busy (one heavy job at a time machine-wide), a note says
  so instead of waiting.

On later turns (4.2) nothing is resent natively: the extracted text when it
fits HISTORY_TEXT_CHARS_PER_DOC / HISTORY_TEXT_CHARS_TOTAL, else a stub that
points the model at read_attachment.

pdf_input_total{status, vendor} counts every document sent:
native | text | page_images | reference | unreadable | busy.
"""
import base64
import logging
from dataclasses import dataclass

from graph import attachments, capabilities, pdf_metrics
from graph.image_normalize import _BUDGET_TIERS, _DEFAULT_REQUEST_IMAGE_BUDGET, _REQUEST_IMAGE_BUDGET

logger = logging.getLogger(__name__)

MAX_NATIVE_PAGES = 100
# Plan 1.12's one request attachment budget (20 MB raw, about 26.7 MB as
# base64), within the vendor's own request budget.
REQUEST_ATTACHMENT_BUDGET_B64 = 4 * ((20 * 1024 * 1024 + 2) // 3)
# Extracted text, in characters (about 4 per token).
CURRENT_TEXT_CHARS_PER_DOC = 120_000
CURRENT_TEXT_CHARS_TOTAL = 200_000
HISTORY_TEXT_CHARS_PER_DOC = 60_000    # about 15k tokens (4.2)
HISTORY_TEXT_CHARS_TOTAL = 160_000     # about 40k tokens
MAX_PAGE_IMAGES = 20
PAGE_IMAGE_EDGE = 1568


@dataclass
class DocumentBudget:
    """What this request's documents may still take."""

    native_b64_left: int
    text_chars_left: int = CURRENT_TEXT_CHARS_TOTAL
    history_chars_left: int = HISTORY_TEXT_CHARS_TOTAL
    # Base64 bytes documents took: the image budget shrinks by this much.
    reserved_b64: int = 0


def budget_for(provider: str | None, current_images: int) -> DocumentBudget:
    """The vendor's request budget, less a minimal share for the current
    turn's images (which are always sent), capped at the 20 MB request
    attachment budget."""
    name = (provider or "").lower()
    vendor = _REQUEST_IMAGE_BUDGET.get(name, _DEFAULT_REQUEST_IMAGE_BUDGET)
    keep_for_images = current_images * min(_BUDGET_TIERS)
    return DocumentBudget(native_b64_left=max(0, min(vendor - keep_for_images, REQUEST_ATTACHMENT_BUDGET_B64)))


def pdf_refs(files) -> list[dict]:
    return [f for f in files or [] if isinstance(f, dict) and f.get("origin", "uploaded") == "uploaded"
            and attachments.is_pdf_ref(f)]


def _count(status: str, provider: str | None) -> None:
    try:
        pdf_metrics.PDF_INPUT.labels(status=status, vendor=(provider or "unknown")[:32]).inc()
    except Exception:  # metrics never break a turn
        pass


def _text_block(doc: attachments.Document, limit: int, note: str = "") -> tuple[dict, int]:
    body = doc.text()
    clipped = len(body) > limit
    if clipped:
        body = body[:limit].rstrip()
        note = note or (
            f"[The document continues; call read_attachment(attachment_id='{doc.attachment_id}', "
            "pages='N-M') to read further pages.]"
        )
    text = (
        f'<document name="{doc.filename}" pages="{doc.pages}" id="{doc.attachment_id}">\n'
        f"{body}\n</document>" + (f"\n{note}" if note else "")
    )
    return {"type": "text", "text": text}, len(body)


def _stub(doc: attachments.Document, reason: str = "") -> dict:
    pages = f", {doc.pages} pages" if doc.pages else ""
    extra = f" ({reason})" if reason else ""
    return {"type": "text", "text": (
        f"[document {doc.filename}{pages}, id={doc.attachment_id}{extra}; "
        "use read_attachment to read it]"
    )}


async def current_turn_blocks(files, provider: str | None, model: str | None,
                              budget: DocumentBudget) -> list[dict]:
    """Content blocks for the current turn's uploaded PDFs."""
    blocks: list[dict] = []
    native_ok = capabilities.supports_pdf_input(provider, model)
    for ref in pdf_refs(files):
        doc = await attachments.load(ref)
        if doc.status in ("encrypted", "unreadable", "not_pdf", "too_large"):
            _count("unreadable", provider)
            raise attachments.DocumentError(attachments.user_error(doc))
        if doc.status != "ok":
            _count("busy", provider)
            blocks.append({"type": "text", "text": (
                f"[document {doc.filename} could not be read right now; try again]"
            )})
            continue
        if native_ok and doc.pages <= MAX_NATIVE_PAGES:
            data = await attachments.fetch_bytes(ref["s3_key"])
            b64 = base64.b64encode(data).decode("ascii")
            if len(b64) <= budget.native_b64_left:
                budget.native_b64_left -= len(b64)
                budget.reserved_b64 += len(b64)
                blocks.append({"type": "file", "base64": b64, "mime_type": attachments.PDF_MEDIA_TYPE,
                               "filename": doc.filename})
                _count("native", provider)
                continue
        if doc.scanned:
            if capabilities.supports_vision(provider, model):
                images = await _page_image_blocks(ref, doc, budget)
                if images:
                    blocks.append({"type": "text", "text": (
                        f'<document name="{doc.filename}" pages="{doc.pages}" id="{doc.attachment_id}">'
                        f" (scanned; images of its first {len(images)} page(s) follow)"
                    )})
                    blocks.extend(images)
                    _count("page_images", provider)
                    continue
            blocks.append({"type": "text", "text": (
                f"[document {doc.filename}, {doc.pages} pages: it has no extractable text (it "
                "appears to be scanned) and this model cannot read it. Tell the user.]"
            )})
            _count("unreadable", provider)
            continue
        limit = min(CURRENT_TEXT_CHARS_PER_DOC, budget.text_chars_left)
        if limit <= 0:
            blocks.append(_stub(doc, "too long to include"))
            _count("reference", provider)
            continue
        block, used = _text_block(doc, limit)
        budget.text_chars_left -= used
        blocks.append(block)
        _count("text", provider)
    return blocks


async def _page_image_blocks(ref: dict, doc: attachments.Document, budget: DocumentBudget) -> list[dict]:
    pages = list(range(min(doc.pages, MAX_PAGE_IMAGES)))
    images = await attachments.page_images(ref, pages, PAGE_IMAGE_EDGE)
    blocks = []
    for jpeg in images:
        b64 = base64.b64encode(jpeg).decode("ascii")
        if len(b64) > budget.native_b64_left:
            break
        budget.native_b64_left -= len(b64)
        budget.reserved_b64 += len(b64)
        blocks.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}})
    return blocks


async def history_turn_blocks(files, provider: str | None, budget: DocumentBudget) -> list[dict]:
    """Blocks for an earlier turn's uploaded PDFs (4.2): never the native
    file again; the extracted text when it fits, else a stub."""
    blocks: list[dict] = []
    for ref in pdf_refs(files):
        doc = await attachments.load(ref)
        if doc.status != "ok" or doc.scanned:
            reason = "scanned, no text" if doc.scanned else ""
            blocks.append(_stub(doc, reason))
            _count("reference", provider)
            continue
        size = len(doc.text())
        if size > HISTORY_TEXT_CHARS_PER_DOC or size > budget.history_chars_left:
            blocks.append(_stub(doc))
            _count("reference", provider)
            continue
        block, used = _text_block(doc, size)
        budget.history_chars_left -= used
        blocks.append(block)
        _count("text", provider)
    return blocks


def mark_cache_breakpoint(blocks: list[dict]) -> list[dict]:
    """Anthropic: cache_control on the last document block of the current
    turn, so its tool rounds reuse the cached document (4.2)."""
    for i in range(len(blocks) - 1, -1, -1):
        if blocks[i].get("type") in ("file", "image_url", "text"):
            blocks[i] = {**blocks[i], "cache_control": {"type": "ephemeral"}}
            break
    return blocks
