"""Wire contract v2 of the activity log.

Every event is a flat JSON object `{"v": 2, "at": <ms since the turn started,
or None for history converted from the old format>, "type": <TYPE>, ...}`.
The retrieval server streams each one as `{"activity": <event>}`, the proxy
relays it as the `ac` frame and persists the turn's events, in stream order, as
`Message.activityJson`. Clients order events by array position, never by `at`.

The golden logs under tests/fixtures/activity/ are the executable form of this
contract; the component library and the iOS app test against copies of them.
A breaking change bumps ACTIVITY_VERSION and regenerates those files.
"""
from typing import Any, Optional

ACTIVITY_VERSION = 2

TURN_START = "turn.start"
STEP_START = "step.start"
STEP_PROGRESS = "step.progress"
STEP_CALL = "step.call"
STEP_END = "step.end"
TURN_END = "turn.end"
EVENT_TYPES = (TURN_START, STEP_START, STEP_PROGRESS, STEP_CALL, STEP_END, TURN_END)

KIND_MEMORY = "memory"
KIND_LLM = "llm"
KIND_TOOLS = "tools"
KIND_INPUT = "input"
STEP_KINDS = (KIND_MEMORY, KIND_LLM, KIND_TOOLS, KIND_INPUT)

# Why an llm step ended. tool_calls: the model asked for tools (a planning or
# reasoning round). answer / structured: it produced the turn's reply. output:
# a non-generator node wrote state for later nodes. empty: nothing at all
# (a refusal or a safety block returns no content and no error).
OUTCOME_TOOL_CALLS = "tool_calls"
OUTCOME_ANSWER = "answer"
OUTCOME_STRUCTURED = "structured"
OUTCOME_OUTPUT = "output"
OUTCOME_EMPTY = "empty"
LLM_OUTCOMES = (OUTCOME_TOOL_CALLS, OUTCOME_ANSWER, OUTCOME_STRUCTURED, OUTCOME_OUTPUT, OUTCOME_EMPTY)

# How the tool executor treated one call under the per-turn web-search budget:
# run as issued, run with a consolidation note, skipped (refine guidance
# returned instead of results), or denied past the hard cap.
CALL_MODES = ("run", "note", "skip", "exhausted")

TURN_COMPLETED = "completed"
TURN_ERROR = "error"
TURN_OUTCOMES = (TURN_COMPLETED, TURN_ERROR)

# Name of the LangGraph custom event a node dispatches when one tool call
# finishes, ahead of the step's end (see activity.report_call).
CALL_FINISHED_EVENT = "activity.call"


def _event(type_: str, at: Optional[int], **fields: Any) -> dict:
    event = {"v": ACTIVITY_VERSION, "at": at, "type": type_}
    event.update({k: v for k, v in fields.items() if v is not None})
    return event


def turn_start(at: Optional[int] = 0) -> dict:
    return _event(TURN_START, at)


def step_start(at: Optional[int], step_id: str, kind: str, node: str, name: str) -> dict:
    return _event(STEP_START, at, id=step_id, kind=kind, node=node, name=name)


def step_progress(at: Optional[int], step_id: str, first_token_ms: int) -> dict:
    """A streaming llm step wrote its first text (preamble or answer)."""
    return _event(STEP_PROGRESS, at, id=step_id, first_token_ms=first_token_ms)


def step_call(at: Optional[int], step_id: str, call: dict) -> dict:
    """One tool call of a running tools step finished. Carries the call's
    status facts only; its numbered sources arrive with the step's end."""
    return _event(STEP_CALL, at, id=step_id, call=call)


def step_end(at: Optional[int], step_id: str, kind: str, node: str, name: str,
             duration_ms: Optional[int], **payload: Any) -> dict:
    return _event(STEP_END, at, id=step_id, kind=kind, node=node, name=name,
                  duration_ms=duration_ms, **payload)


def turn_end(at: Optional[int], duration_ms: Optional[int], outcome: str,
             cited: Optional[list] = None) -> dict:
    """`cited`: the source indices the final answer cites, present when the
    turn found any sources (possibly empty)."""
    return _event(TURN_END, at, duration_ms=duration_ms, outcome=outcome, cited=cited)


_REQUIRED = {
    TURN_START: (),
    STEP_START: ("id", "kind", "node", "name"),
    STEP_PROGRESS: ("id", "first_token_ms"),
    STEP_CALL: ("id", "call"),
    STEP_END: ("id", "kind", "node", "name"),
    TURN_END: ("outcome",),
}

_REQUIRED_BY_KIND = {
    KIND_MEMORY: ("counts",),
    KIND_LLM: ("outcome",),
    KIND_TOOLS: ("calls",),
    KIND_INPUT: (),
}


def validate(event: Any) -> None:
    """Raise ValueError when `event` breaks the contract."""
    if not isinstance(event, dict):
        raise ValueError("an activity event is a JSON object")
    if event.get("v") != ACTIVITY_VERSION:
        raise ValueError(f"unsupported activity version {event.get('v')!r}")
    type_ = event.get("type")
    if type_ not in _REQUIRED:
        raise ValueError(f"unknown activity event type {type_!r}")
    at = event.get("at", "missing")
    if at == "missing" or not (at is None or (isinstance(at, int) and at >= 0)):
        raise ValueError(f"{type_}: 'at' must be a non-negative int or null")
    missing = [k for k in _REQUIRED[type_] if k not in event]
    if type_ in (STEP_START, STEP_END):
        kind = event.get("kind")
        if kind not in STEP_KINDS:
            raise ValueError(f"{type_}: unknown step kind {kind!r}")
        if type_ == STEP_END:
            missing += [k for k in _REQUIRED_BY_KIND[kind] if k not in event]
            if kind == KIND_LLM and event.get("outcome") not in LLM_OUTCOMES:
                raise ValueError(f"step.end: unknown llm outcome {event.get('outcome')!r}")
            if kind == KIND_TOOLS:
                for call in event.get("calls") or []:
                    _validate_call(call, require_sources=True)
    if type_ == STEP_CALL:
        _validate_call(event.get("call"), require_sources=False)
    if type_ == TURN_END and event.get("outcome") not in TURN_OUTCOMES:
        raise ValueError(f"turn.end: unknown outcome {event.get('outcome')!r}")
    if type_ == TURN_END and "cited" in event and not (
            isinstance(event["cited"], list) and all(isinstance(i, int) for i in event["cited"])):
        raise ValueError("turn.end: cited must be a list of source indices")
    if missing:
        raise ValueError(f"{type_}: missing {', '.join(missing)}")


def _validate_call(call: Any, require_sources: bool) -> None:
    if not isinstance(call, dict):
        raise ValueError("a tool call entry is a JSON object")
    for key in ("name", "mode"):
        if key not in call:
            raise ValueError(f"tool call: missing {key}")
    if call["mode"] not in CALL_MODES:
        raise ValueError(f"tool call: unknown mode {call['mode']!r}")
    if require_sources and not isinstance(call.get("sources"), list):
        raise ValueError("tool call: sources must be a list")
