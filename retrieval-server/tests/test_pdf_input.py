"""Unit tests for uploaded-PDF input: capability resolution, per-vendor native
blocks, the current-turn dispatch, and the files→state wiring.

These avoid the parser deps (pypdfium2/pdfplumber) and S3 entirely: the native
path needs neither, and the fallback paths are exercised by monkeypatching the
pdf_input fetch/render/extract seams. Async helpers are driven with asyncio.run
so no pytest-asyncio dependency is required."""
import asyncio

from graph import pdf_input
from graph.image_normalize import limits_for_request
from graph.model_capabilities import ModelCaps, caps_from_info, model_capabilities
from graph.nodes.llm_node import RequestImagePlan, _file_blocks, _history_file_note


# ── model_capabilities ───────────────────────────────────────────────────────

def test_caps_from_info_reads_both_flags():
    caps = caps_from_info("openai", "gpt-x", {"supports_pdf_input": True, "supports_vision": True})
    assert caps == ModelCaps(pdf_input=True, vision=True)


def test_caps_from_info_defaults_false_for_unknown_nonnative():
    assert caps_from_info("somevendor", "mystery-model", {}) == ModelCaps(pdf_input=False, vision=False)


def test_anthropic_is_pdf_native_even_when_map_is_empty():
    # The snapshot may lag a new Claude release; the short-circuit still reports PDF support.
    assert caps_from_info("anthropic", "claude-future", {}).pdf_input is True
    assert model_capabilities("anthropic", "claude-sonnet-5").pdf_input is True


def test_overrides_win(monkeypatch):
    from graph import model_capabilities as mc
    monkeypatch.setitem(mc._OVERRIDES, "edge-model", (True, None))
    caps = caps_from_info("somevendor", "edge-model", {"supports_vision": True})
    assert caps == ModelCaps(pdf_input=True, vision=True)


# ── per-vendor native document blocks ────────────────────────────────────────

def test_native_block_anthropic():
    b = pdf_input.native_block("anthropic", "QkFTRTY0", "r.pdf")
    assert b["type"] == "document"
    assert b["source"] == {"type": "base64", "media_type": "application/pdf", "data": "QkFTRTY0"}


def test_native_block_openai_carries_filename():
    b = pdf_input.native_block("openai", "data:application/pdf;base64,QkFTRTY0", "résumé.pdf")
    assert b["type"] == "file"
    assert b["file"]["filename"] == "résumé.pdf"
    assert b["file"]["file_data"] == "data:application/pdf;base64,QkFTRTY0"


def test_native_block_gemini():
    b = pdf_input.native_block("gemini", "QkFTRTY0", None)
    assert b == {"type": "media", "mime_type": "application/pdf", "data": "QkFTRTY0"}


def test_native_block_unknown_provider_is_none():
    assert pdf_input.native_block("llamafarm", "QkFTRTY0", "x.pdf") is None


# ── history note (documents are not re-sent every turn) ──────────────────────

def test_history_file_note_lists_names():
    note = _history_file_note([{"filename": "a.pdf"}, {"filename": None}])
    assert "a.pdf" in note and "document.pdf" in note


def test_history_file_note_empty():
    assert _history_file_note([]) == ""
    assert _history_file_note(None) == ""


# ── current-turn dispatch (_file_blocks) ─────────────────────────────────────

def _run(coro):
    return asyncio.run(coro)


def _patch_caps(monkeypatch, caps):
    from graph import model_capabilities as mc
    monkeypatch.setattr(mc, "model_capabilities", lambda provider, model: caps)


def _pdf_file(name="doc.pdf"):
    return {"s3_key": "customers/c/attachments/x", "media_type": "application/pdf", "filename": name}


def test_dispatch_native_when_pdf_capable(monkeypatch):
    _patch_caps(monkeypatch, ModelCaps(pdf_input=True, vision=True))

    async def fake_native(provider, s3_key, filename):
        return {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": "X"}}
    monkeypatch.setattr(pdf_input, "native_pdf_block", fake_native)

    blocks = _run(_file_blocks([_pdf_file()], "anthropic", "claude-sonnet-5", RequestImagePlan(limits_for_request("anthropic", 1))))
    assert len(blocks) == 1 and blocks[0]["type"] == "document"


def test_dispatch_page_images_when_vision_only(monkeypatch):
    _patch_caps(monkeypatch, ModelCaps(pdf_input=False, vision=True))

    async def fake_pages(s3_key, provider, other_images=0, max_pages=30):
        return [{"type": "image_url", "image_url": {"url": "data:image/png;base64,P1"}},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,P2"}}]
    monkeypatch.setattr(pdf_input, "pdf_page_image_blocks", fake_pages)

    blocks = _run(_file_blocks([_pdf_file()], "xai", "grok-vision", RequestImagePlan(limits_for_request("xai", 1))))
    assert len(blocks) == 2 and all(b["type"] == "image_url" for b in blocks)


def test_dispatch_text_when_no_vision_no_pdf(monkeypatch):
    _patch_caps(monkeypatch, ModelCaps(pdf_input=False, vision=False))

    async def fake_text(s3_key, filename, max_chars=60000):
        return "[Attached PDF: doc.pdf]\nhello world"
    monkeypatch.setattr(pdf_input, "pdf_extracted_text", fake_text)

    blocks = _run(_file_blocks([_pdf_file()], "deepseek", "deepseek-chat", RequestImagePlan(limits_for_request("deepseek", 1))))
    assert len(blocks) == 1 and blocks[0]["type"] == "text" and "hello world" in blocks[0]["text"]


def test_dispatch_empty_files_is_empty():
    assert _run(_file_blocks([], "anthropic", "claude-sonnet-5", RequestImagePlan(limits_for_request("anthropic", 0)))) == []


def test_dispatch_non_pdf_degrades_to_note(monkeypatch):
    _patch_caps(monkeypatch, ModelCaps(pdf_input=True, vision=True))
    f = {"s3_key": "k", "media_type": "application/zip", "filename": "a.zip"}
    blocks = _run(_file_blocks([f], "anthropic", "claude-sonnet-5", RequestImagePlan(limits_for_request("anthropic", 1))))
    assert len(blocks) == 1 and blocks[0]["type"] == "text" and "not a supported type" in blocks[0]["text"]


# ── files → state wiring (_build_state) ──────────────────────────────────────

def test_build_state_carries_query_files():
    from models import RawData, RetrieveRequest
    from routes.retrieve import _build_state

    req = RetrieveRequest(
        customer_id="c", client="web", data_type="text",
        raw_data=RawData(
            query_data="summarize this",
            files=[{"s3_key": "customers/c/attachments/x", "media_type": "application/pdf", "filename": "d.pdf"}],
        ),
        llm_credentials={}, llm_provider="anthropic", llm_model="claude-sonnet-5",
    )
    state = _build_state(req, node_configs={}, builtin_tools=[])
    assert state["query_files"] == [
        {"s3_key": "customers/c/attachments/x", "media_type": "application/pdf", "filename": "d.pdf"}
    ]
