"""The conversation's non-image files, as the tools see them (plan 3.1).

The proxy sends FileRefs on history turns (generated files on assistant
turns, uploaded documents on user turns) and on the current turn
(raw_data.files). They are collected once, when the request's state is built,
into state["conversation_files"]: a list of FileRef dicts, references only.
The tool executor turns it into runtime["conversation_files"], keyed by
attachment_id, which is the ONLY way revise_pdf, read_pdf_source and
read_attachment resolve an id: a tool never builds a storage key from model
input, and the stored s3_key is used exactly as given (in a shared
conversation a file can sit under another participant's prefix).
"""
from typing import Iterable

ORIGINS = ("generated", "uploaded")


def _ref(raw) -> dict | None:
    ref = raw.model_dump() if hasattr(raw, "model_dump") else dict(raw or {})
    if not ref.get("attachment_id") or not ref.get("s3_key"):
        return None
    origin = ref.get("origin")
    return {
        "attachment_id": str(ref["attachment_id"]),
        "s3_key": str(ref["s3_key"]),
        "media_type": str(ref.get("media_type") or "application/octet-stream"),
        "filename": ref.get("filename"),
        "size_bytes": ref.get("size_bytes"),
        "origin": origin if origin in ORIGINS else "uploaded",
    }


def collect(history: Iterable, current_files: Iterable = ()) -> list[dict]:
    """Every file of the conversation, oldest first, each attachment once."""
    out: list[dict] = []
    seen: set[str] = set()
    for turn in history or []:
        files = turn.get("files") if isinstance(turn, dict) else getattr(turn, "files", None)
        for raw in files or []:
            ref = _ref(raw)
            if ref and ref["attachment_id"] not in seen:
                seen.add(ref["attachment_id"])
                out.append(ref)
    for raw in current_files or []:
        ref = _ref(raw)
        if ref and ref["attachment_id"] not in seen:
            seen.add(ref["attachment_id"])
            out.append(ref)
    return out


def by_id(files: Iterable[dict]) -> dict:
    """runtime["conversation_files"]: {attachment_id: {s3_key, filename,
    media_type, origin, size_bytes}}."""
    out: dict = {}
    for f in files or []:
        if f.get("attachment_id") and f.get("s3_key"):
            out[f["attachment_id"]] = {
                "s3_key": f["s3_key"],
                "filename": f.get("filename"),
                "media_type": f.get("media_type"),
                "origin": f.get("origin") or "uploaded",
                "size_bytes": f.get("size_bytes"),
            }
    return out
