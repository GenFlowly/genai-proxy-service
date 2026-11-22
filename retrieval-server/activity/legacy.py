"""v1 thinking steps (Message.thinkingStepsJson) → v2 activity events.

Used once, by the history migration, so turns recorded before the activity
log still show a panel. v1 stored the raw running/done step events of each
graph node; v2 is the activity log the clients render. Nothing here invents
data: v1 kept no timings (every `at` is None, and the turn's duration is the
old "thought for" time when it was recorded), and the retired search and
retrieval node steps kept result titles without links, so those become a
call's result count and excerpt rather than sources.
"""
import re
from typing import Optional

from activity import schema

_MEMORY_COUNTS = re.compile(r"Applied (\d+) (?:core|learned) memori")
_MEMORY_RECALLED = re.compile(r"recalled (\d+) related")
_FOUND = re.compile(r"Found (\d+)")
_CALLED_TOOL = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)\(")
_EXCERPT_CHARS = 200

_KIND = {
    "MEMORY": schema.KIND_MEMORY,
    "TOOL": schema.KIND_TOOLS,
    "WEB_SEARCH": schema.KIND_TOOLS,
    "RETRIEVAL": schema.KIND_TOOLS,
}
_RETIRED_NODE_TOOL = {"WEB_SEARCH": "web_search", "RETRIEVAL": "search_knowledge_base"}


def _fold(raw_steps: list) -> list[dict]:
    """The v1 client fold: a `done` (or a repeated `running`) updates the newest
    still-running entry of its node; otherwise the event starts a new entry."""
    steps: list[dict] = []
    for event in raw_steps:
        if not isinstance(event, dict) or not isinstance(event.get("node"), str):
            continue
        latest = next((s for s in reversed(steps) if s["node"] == event["node"]), None)
        if latest is not None and latest.get("status") == "running":
            latest.update(event)
        else:
            steps.append(dict(event))
    return steps


def _excerpt(text) -> Optional[str]:
    return text[:_EXCERPT_CHARS] if isinstance(text, str) and text else None


def _memory_fields(step: dict) -> dict:
    memories = step.get("memories") if isinstance(step.get("memories"), dict) else None
    if memories:
        core = [m for m in memories.get("core") or [] if isinstance(m, str)]
        recalled = [m for m in memories.get("recalled") or [] if isinstance(m, str)]
        return {"counts": {"core": len(core), "recalled": len(recalled)},
                "memories": {"core": core, "recalled": recalled}}
    detail = step.get("detail") or ""
    core = _MEMORY_COUNTS.search(detail)
    recalled = _MEMORY_RECALLED.search(detail)
    items = [m for m in step.get("items") or [] if isinstance(m, str)]
    counts = {
        "core": int(core.group(1)) if core else len(items),
        "recalled": int(recalled.group(1)) if recalled else 0,
    }
    fields: dict = {"counts": counts}
    if items:
        fields["memories"] = {"core": items, "recalled": []}
    return fields


def _requests_of(step: dict, step_id: str) -> list[dict]:
    """The tool calls an llm step asked for. v1 stored them structured late in
    its life; earlier records only have the "Calling tools: …" line."""
    raw = step.get("tool_calls")
    if isinstance(raw, list) and raw:
        calls = [c for c in raw if isinstance(c, dict) and c.get("name")]
    else:
        detail = step.get("detail") or ""
        if not detail.startswith("Calling tools"):
            return []
        names = _CALLED_TOOL.findall(detail) or [
            n.strip() for n in detail.split(":", 1)[-1].split(",") if n.strip()
        ]
        calls = [{"name": n} for n in names]
    return [
        {"id": c.get("id") or f"{step_id}#{i}", "name": c["name"], "args": c.get("args") or {}}
        for i, c in enumerate(calls, start=1)
    ]


def _tools_calls(step: dict, requests: list[dict]) -> list[dict]:
    kind = step.get("kind")
    if kind in _RETIRED_NODE_TOOL:
        found = _FOUND.search(step.get("detail") or "")
        items = [i for i in step.get("items") or [] if isinstance(i, str)]
        return [{
            "id": "", "seq": 1, "name": _RETIRED_NODE_TOOL[kind], "args": {}, "mode": "run",
            "result_count": int(found.group(1)) if found else len(items),
            "result_excerpt": _excerpt("; ".join(items)),
            "sources": [], "artifacts": [], "error": None,
        }]
    raw = step.get("calls")
    if isinstance(raw, list) and raw:
        calls = [c for c in raw if isinstance(c, dict) and c.get("name")]
    else:
        names = [n.strip() for n in (step.get("prompt") or "").split(",") if n.strip()]
        calls = [{"name": n} for n in names]
    out = []
    for seq, call in enumerate(calls, start=1):
        request = requests[seq - 1] if seq <= len(requests) else {}
        sources = [s for s in call.get("sources") or [] if isinstance(s, dict) and isinstance(s.get("index"), int)]
        error = call.get("error") if isinstance(call.get("error"), str) else None
        entry = {
            "id": request.get("id", ""), "seq": seq, "name": call["name"],
            "args": call.get("args") or request.get("args") or {}, "mode": "run",
            "result_count": None if error else len(sources),
            "sources": sources,
            "artifacts": [a for a in call.get("artifacts") or [] if isinstance(a, dict)],
            "error": error,
        }
        if isinstance(call.get("details"), dict):
            entry["details"] = call["details"]
        out.append(entry)
    return out


def convert(raw_steps: list, thinking_duration_ms: Optional[int] = None,
            web_sources: Optional[list] = None) -> list[dict]:
    """The v2 activity log for one v1 turn; [] when there is nothing to show."""
    steps = _fold(raw_steps if isinstance(raw_steps, list) else [])
    if not steps:
        return []
    answer_index = max(
        (i for i, s in enumerate(steps)
         if s.get("status") == "done" and _KIND.get(s.get("kind"), schema.KIND_LLM) == schema.KIND_LLM
         and not _requests_of(s, "")),
        default=-1,
    )
    events = [schema.turn_start(None)]
    occurrences: dict[str, int] = {}
    pending_requests: list[dict] = []
    any_sources = False
    for i, step in enumerate(steps):
        node = step["node"]
        occurrences[node] = occurrences.get(node, 0) + 1
        step_id = f"{node}:{occurrences[node]}"
        kind = _KIND.get(step.get("kind"), schema.KIND_LLM)
        name = step.get("name") or node
        events.append(schema.step_start(None, step_id, kind, node, name))
        if step.get("status") != "done":
            continue
        if kind == schema.KIND_MEMORY:
            fields = _memory_fields(step)
        elif kind == schema.KIND_TOOLS:
            fields = {"calls": _tools_calls(step, pending_requests)}
            if isinstance(step.get("todos"), list):
                fields["todos"] = step["todos"]
            any_sources = any_sources or any(c["sources"] for c in fields["calls"])
            pending_requests = []
        else:
            requests = _requests_of(step, step_id)
            developer = {}
            if _excerpt(step.get("prompt")):
                developer["prompt_excerpt"] = step["prompt"][:1500]
            if requests:
                fields = {"outcome": schema.OUTCOME_TOOL_CALLS, "tool_calls": requests}
                if isinstance(step.get("reasoning"), str) and step["reasoning"].strip():
                    fields["reasoning"] = step["reasoning"].strip()
                pending_requests = requests
            elif i == answer_index:
                fields = {"outcome": schema.OUTCOME_ANSWER}
            else:
                fields = {"outcome": schema.OUTCOME_OUTPUT}
                if isinstance(step.get("detail"), str) and step["detail"]:
                    fields["summary"] = step["detail"]
                if isinstance(step.get("response"), str) and step["response"]:
                    developer["response_excerpt"] = step["response"][:1500]
            if developer:
                fields["developer"] = developer
        events.append(schema.step_end(None, step_id, kind, node, name, None, **fields))
    cited = None
    if any_sources and isinstance(web_sources, list):
        cited = sorted({s["index"] for s in web_sources if isinstance(s, dict) and isinstance(s.get("index"), int)})
    events.append(schema.turn_end(None, thinking_duration_ms, schema.TURN_COMPLETED, cited=cited))
    for event in events:
        schema.validate(event)
    return events
