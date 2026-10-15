"""Was a model response cut off, or does it carry malformed tool calls?

On the streaming paths, LangChain's parse_partial_json turns a tool call cut
off at the output limit into a VALID one: a generate_pdf call whose Markdown
was truncated mid-document parses fine, renders a truncated PDF and reports
success. So a call is trusted only when the response ended normally.

A response counts as cut off when any of these holds:
- stop_reason / finish_reason is max_tokens, length or MAX_TOKENS
  (Anthropic, OpenAI Chat, Gemini and the LiteLLM tier);
- response_metadata status is 'incomplete' (OpenAI Responses API, e.g. gpt-5,
  which carries no stop/finish reason): the reason comes from
  incomplete_details, e.g. max_output_tokens;
and it carries malformed calls when invalid_tool_calls is non-empty (reason
'invalid_tool_call').
"""
_CUT_OFF = {"max_tokens", "length", "max_output_tokens", "model_length", "max_tokens_exceeded"}


def _metadata(message) -> dict:
    meta = getattr(message, "response_metadata", None)
    return meta if isinstance(meta, dict) else {}


def cut_off_reason(message) -> str | None:
    """The cut-off reason ('max_tokens', 'length', 'max_output_tokens', ...),
    lowercased, or None when the response ended normally."""
    meta = _metadata(message)
    for key in ("stop_reason", "finish_reason"):
        value = meta.get(key)
        if isinstance(value, str) and value.lower() in _CUT_OFF:
            return value.lower()
    if str(meta.get("status") or "").lower() == "incomplete":
        details = meta.get("incomplete_details")
        reason = details.get("reason") if isinstance(details, dict) else getattr(details, "reason", None)
        return str(reason or "incomplete").lower()
    return None


def truncation_reason(message) -> str | None:
    """cut_off_reason, else 'invalid_tool_call' when the response carries
    tool calls the provider could not parse, else None."""
    reason = cut_off_reason(message)
    if reason:
        return reason
    if getattr(message, "invalid_tool_calls", None):
        return "invalid_tool_call"
    return None


def stop_reason_of(message) -> str:
    """The vendor's raw finish reason, lowercased, or "": stop_reason
    (Anthropic) / finish_reason (OpenAI, Gemini), else the Responses API's
    incomplete reason."""
    meta = _metadata(message)
    reason = meta.get("stop_reason") or meta.get("finish_reason") or ""
    if isinstance(reason, str) and reason:
        return reason.lower()
    return cut_off_reason(message) or ""


NOT_EXECUTED_CUT_OFF = (
    "This call was cut off at the output token limit and was NOT executed; no file "
    "was created. Shorten the document or split it into several smaller PDFs."
)
NOT_EXECUTED_CUT_OFF_FS = (
    "This call was cut off at the output token limit and was NOT executed; no file "
    "was created. Shorten the document, split it into several smaller PDFs, or write "
    "it in sections with fs_write (mode 'append') and render them with "
    "generate_pdf(source_paths=[...])."
)
NOT_EXECUTED_MALFORMED = (
    "The tool arguments were not valid JSON; the call was NOT executed. "
    "Retry with valid arguments."
)


def refusal_text(reason: str | None, fs_write_enabled: bool = False) -> str:
    """What the model is told instead of running a truncated call."""
    if reason == "invalid_tool_call":
        return NOT_EXECUTED_MALFORMED
    return NOT_EXECUTED_CUT_OFF_FS if fs_write_enabled else NOT_EXECUTED_CUT_OFF
