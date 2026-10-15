"""Tool-call arguments as shown in thinking steps and traces.

Every tool argument used to be copied in full, three times, into the
persisted thinking steps (the call label, the structured call list and the
executor's call trace). A generate_pdf call carries the whole document, so a
~125k-char document made the message's DynamoDB item exceed 400 KB and the
reply (with its PDF) failed to persist. Long string arguments are therefore
shown as a short head plus their length; the document itself is stored next
to the PDF (save_artifact's source sidecar), not in thinking steps.
"""
from typing import Any

MAX_SHOWN_CHARS = 300
HEAD_CHARS = 120


def display_value(value: Any) -> Any:
    """A display copy of `value` with long strings shortened, recursively."""
    if isinstance(value, str):
        if len(value) > MAX_SHOWN_CHARS:
            return f"{value[:HEAD_CHARS]}... ({len(value):,} chars)"
        return value
    if isinstance(value, dict):
        return {k: display_value(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [display_value(v) for v in value]
    return value


def display_args(args: dict | None) -> dict:
    """Tool-call arguments for display: strings over MAX_SHOWN_CHARS become
    their first HEAD_CHARS characters plus '... (N chars)'."""
    return display_value(args or {})
