"""LangGraph `astream_events` (v2) → activity events.

One recorder per turn. `streaming.stream_events_dicts` calls `observe` with
every graph event, in order, and forwards what comes back; the durable /runs
path keeps one recorder across human-input resumes and calls `pause` /
`resume` around the wait so waiting time is not counted.

Only the top-level graph's nodes become steps. A subagent's own graph runs
inside a tool call and its events surface in the same stream; they are
ignored here, and the subagent's trace reaches the panel through the call's
`details` instead.
"""
import time
from typing import Callable, Optional

from activity import schema

# Bounds each developer excerpt; the persisted log shares a 400 KB DynamoDB item.
_DEVELOPER_TEXT_LIMIT = 1500


def stop_reason_of(output) -> str:
    """The vendor's raw finish reason for one LLM call, lowercased, or "".

    stop_reason on Anthropic, finish_reason on OpenAI chat completions and
    Gemini. The OpenAI Responses API (the gpt-5 family) reports a `status`
    instead: "completed" is a normal stop, "incomplete" carries its reason
    (max_output_tokens, content_filter) in `incomplete_details`. A refusal
    returns empty content and no exception, so the stream surfaces this to
    explain an empty reply."""
    meta = getattr(output, "response_metadata", None) or {}
    reason = meta.get("stop_reason") or meta.get("finish_reason") or ""
    if not reason and isinstance(meta.get("status"), str):
        details = meta.get("incomplete_details") or {}
        if meta["status"] == "completed":
            reason = "stop"
        elif meta["status"] == "incomplete":
            reason = (details.get("reason") if isinstance(details, dict) else None) or "incomplete"
        else:
            reason = meta["status"]
    return reason.lower() if isinstance(reason, str) else ""


def chunk_text(chunk) -> str:
    """The plain text of one streamed chunk. With tools bound, providers stream
    tool-call argument deltas as block lists; only text blocks count."""
    content = getattr(chunk, "content", None)
    if isinstance(content, list):
        return "".join(
            b.get("text", "") for b in content
            if isinstance(b, dict) and b.get("type") == "text"
        )
    return content if isinstance(content, str) else ""


def kind_of(node_type: str) -> str:
    key = (node_type or "").upper()
    if key == "MEMORY":
        return schema.KIND_MEMORY
    if key == "TOOL_EXECUTOR":
        return schema.KIND_TOOLS
    if key == "HUMAN_INPUT":
        return schema.KIND_INPUT
    return schema.KIND_LLM


def _is_nested(event: dict) -> bool:
    """True for events from a graph invoked inside one of this graph's nodes
    (a subagent): LangGraph joins nested checkpoint namespaces with '|'."""
    return "|" in ((event.get("metadata") or {}).get("langgraph_checkpoint_ns") or "")


class _Step:
    __slots__ = ("id", "kind", "node", "name", "started", "first_token_ms")

    def __init__(self, step_id: str, kind: str, node: str, name: str, started: float):
        # Elapsed turn time (seconds, pauses excluded) when the step started.
        self.id = step_id
        self.kind = kind
        self.node = node
        self.name = name
        self.started = started
        self.first_token_ms: Optional[int] = None


class ActivityRecorder:
    def __init__(
        self,
        node_type_map: Optional[dict] = None,
        node_name_map: Optional[dict] = None,
        streaming_nodes: Optional[set] = None,
        structured_output: bool = False,
        started_at: Optional[float] = None,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._types = node_type_map or {}
        self._names = node_name_map or {}
        self._streaming = streaming_nodes or set()
        self._structured = structured_output
        self._clock = clock
        self._t0 = started_at if started_at is not None else clock()
        self._paused_total = 0.0
        self._paused_at: Optional[float] = None
        self._begun = False
        self._finished = False
        self._cited: Optional[list] = None
        self._occurrences: dict[str, int] = {}
        self._open: dict[str, _Step] = {}        # correlation key -> step
        self._open_by_node: dict[str, list[str]] = {}  # node -> correlation keys, oldest first

    # ----- clock -------------------------------------------------------------

    def _elapsed(self) -> float:
        now = self._clock()
        paused = self._paused_total + ((now - self._paused_at) if self._paused_at is not None else 0.0)
        return max(0.0, now - self._t0 - paused)

    def _at(self) -> int:
        return int(round(self._elapsed() * 1000))

    # ----- lifecycle ---------------------------------------------------------

    def begin(self) -> list[dict]:
        if self._begun:
            return []
        self._begun = True
        return [schema.turn_start(0)]

    def pause(self) -> list[dict]:
        """The run waits on a human. Steps still open (the input node that
        interrupted) end here; the resumed node runs again as a new step."""
        out = []
        for key in list(self._open):
            step = self._open.pop(key)
            self._open_by_node[step.node].remove(key)
            out.append(schema.step_end(
                self._at(), step.id, step.kind, step.node, step.name,
                self._duration_ms(step), interrupted=True,
                **({"outcome": schema.OUTCOME_EMPTY} if step.kind == schema.KIND_LLM else {}),
                **({"calls": []} if step.kind == schema.KIND_TOOLS else {}),
                **({"counts": {"core": 0, "recalled": 0}} if step.kind == schema.KIND_MEMORY else {}),
            ))
        if self._paused_at is None:
            self._paused_at = self._clock()
        return out

    def resume(self) -> None:
        if self._paused_at is not None:
            self._paused_total += self._clock() - self._paused_at
            self._paused_at = None

    def cite(self, indices) -> None:
        """The source indices the turn's final answer cites; carried on
        turn.end so clients never have to guess from interim source lists."""
        self._cited = sorted({int(i) for i in indices})

    def finish(self, outcome: str = schema.TURN_COMPLETED) -> list[dict]:
        if self._finished:
            return []
        self._finished = True
        out = self.begin()
        at = self._at()
        out.append(schema.turn_end(at, at, outcome, cited=self._cited))
        return out

    # ----- events ------------------------------------------------------------

    def observe(self, event: dict) -> list[dict]:
        out = self.begin()
        if self._finished or _is_nested(event):
            return out
        event_type = event.get("event", "")
        node = (event.get("metadata") or {}).get("langgraph_node", "")
        if not node:
            return out
        if event.get("name") == node and event_type == "on_chain_start":
            out.append(self._start(node, event.get("run_id")))
        elif event.get("name") == node and event_type == "on_chain_end":
            ended = self._end(node, event.get("run_id"), (event.get("data") or {}).get("output"))
            if ended:
                out.append(ended)
        elif event_type == "on_chat_model_stream":
            progress = self._first_token(node, (event.get("data") or {}).get("chunk"))
            if progress:
                out.append(progress)
        elif event_type == "on_custom_event" and event.get("name") == schema.CALL_FINISHED_EVENT:
            call = self._call_finished(node, event.get("data"))
            if call:
                out.append(call)
        return out

    def _start(self, node: str, run_id: Optional[str]) -> dict:
        n = self._occurrences.get(node, 0) + 1
        self._occurrences[node] = n
        node_type = self._types.get(node, node)
        kind = kind_of(node_type)
        name = self._names.get(node) or node_type or node
        step = _Step(f"{node}:{n}", kind, node, name, self._elapsed())
        key = run_id or step.id
        self._open[key] = step
        self._open_by_node.setdefault(node, []).append(key)
        return schema.step_start(self._at(), step.id, kind, node, name)

    def _pop(self, node: str, run_id: Optional[str]) -> Optional[_Step]:
        keys = self._open_by_node.get(node) or []
        key = run_id if run_id in self._open else (keys[-1] if keys else None)
        if key is None:
            return None
        keys.remove(key)
        return self._open.pop(key)

    def _latest_open(self, node: str) -> Optional[_Step]:
        keys = self._open_by_node.get(node) or []
        return self._open[keys[-1]] if keys else None

    def _duration_ms(self, step: _Step) -> int:
        return int(round(max(0.0, self._elapsed() - step.started) * 1000))

    def _first_token(self, node: str, chunk) -> Optional[dict]:
        if node not in self._streaming or self._structured or not chunk_text(chunk):
            return None
        step = self._latest_open(node)
        if step is None or step.first_token_ms is not None:
            return None
        step.first_token_ms = self._duration_ms(step)
        return schema.step_progress(self._at(), step.id, step.first_token_ms)

    def _call_finished(self, node: str, facts) -> Optional[dict]:
        step = self._latest_open(node)
        if step is None or step.kind != schema.KIND_TOOLS or not isinstance(facts, dict):
            return None
        call = {k: facts[k] for k in _LIVE_CALL_KEYS if facts.get(k) is not None}
        if "name" not in call or call.get("mode") not in schema.CALL_MODES:
            return None
        return schema.step_call(self._at(), step.id, call)

    def _end(self, node: str, run_id: Optional[str], output) -> Optional[dict]:
        step = self._pop(node, run_id)
        if step is None:
            return None
        output = output if isinstance(output, dict) else {}
        payload = {
            schema.KIND_MEMORY: _memory_payload,
            schema.KIND_TOOLS: _tools_payload,
            schema.KIND_INPUT: lambda o: {},
        }.get(step.kind)
        if payload is not None:
            fields = payload(output)
        else:
            fields = _llm_payload(output, structured=self._structured)
            if step.first_token_ms is not None:
                fields["first_token_ms"] = step.first_token_ms
        return schema.step_end(self._at(), step.id, step.kind, step.node, step.name,
                               self._duration_ms(step), **fields)


_LIVE_CALL_KEYS = ("id", "seq", "name", "mode", "duration_ms", "result_count", "error")


def _last_trace(output: dict) -> dict:
    trace = output.get("trace") or []
    return trace[-1] if trace and isinstance(trace[-1], dict) else {}


def _memory_payload(output: dict) -> dict:
    block = output.get("memories_block") or ""
    lines = [line[2:] for line in block.splitlines() if line.startswith("- ")]
    stats = (output.get("scratch") or {}).get("memory_stats")
    if isinstance(stats, dict):
        core = int(stats.get("core") or 0)
        recalled = int(stats.get("recalled") or 0)
        # The block renders core lines first, then recalled ones.
        memories = {"core": lines[:core], "recalled": lines[core:core + recalled]}
    else:
        core, recalled = len(lines), 0
        memories = {"core": lines, "recalled": []}
    return {"counts": {"core": core, "recalled": recalled}, "memories": memories}


def _tools_payload(output: dict) -> dict:
    entry = _last_trace(output)
    fields: dict = {"calls": list(entry.get("calls") or [])}
    if isinstance(entry.get("budget"), dict):
        fields["budget"] = entry["budget"]
    if entry.get("todos") is not None:
        fields["todos"] = entry["todos"]
    return fields


def _summary(output: dict) -> Optional[str]:
    intent = output.get("query_intent")
    if intent:
        needs = "yes" if output.get("needs_rewrite") else "no"
        return f"Intent: {intent} (needs rewrite: {needs})"
    if output.get("rewritten_query"):
        return f"Rewrote the query to: {output['rewritten_query']}"
    ranked = output.get("ranked_results")
    if isinstance(ranked, list):
        return f"Kept the {len(ranked)} most relevant result(s)"
    return None


def _llm_payload(output: dict, structured: bool) -> dict:
    fields: dict = {}
    tool_calls = output.get("tool_calls") or []
    response = output.get("generated_response")
    text = response.strip() if isinstance(response, str) else ""
    if tool_calls:
        fields["outcome"] = schema.OUTCOME_TOOL_CALLS
        fields["tool_calls"] = [
            {"id": c.get("id", ""), "name": c.get("name", ""), "args": c.get("args") or {}}
            for c in tool_calls if isinstance(c, dict)
        ]
        if text:
            fields["reasoning"] = text
    elif response:
        fields["outcome"] = schema.OUTCOME_STRUCTURED if structured else schema.OUTCOME_ANSWER
    elif any(v not in (None, "", [], {}) for k, v in output.items() if k not in ("trace", "usage")):
        fields["outcome"] = schema.OUTCOME_OUTPUT
        summary = _summary(output)
        if summary:
            fields["summary"] = summary
    else:
        fields["outcome"] = schema.OUTCOME_EMPTY

    entry = _last_trace(output)
    developer = {}
    if entry.get("prompt"):
        developer["prompt_excerpt"] = str(entry["prompt"])[:_DEVELOPER_TEXT_LIMIT]
    # An answer is the message text and a tool round's text is its `reasoning`;
    # only other outputs are worth their size here.
    if entry.get("response") and fields["outcome"] in (schema.OUTCOME_OUTPUT, schema.OUTCOME_EMPTY):
        developer["response_excerpt"] = str(entry["response"])[:_DEVELOPER_TEXT_LIMIT]
    if developer:
        fields["developer"] = developer
    return fields
