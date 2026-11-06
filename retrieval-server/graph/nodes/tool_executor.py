"""TOOL_EXECUTOR node: executes backend tool calls inside the graph.

The response generator binds the tools enabled for this request (see llm_node)
and may answer with tool_calls. A "tool_route" conditional edge sends in-graph
calls here; this node executes them (concurrently — a turn's calls are
independent by construction, the model issued them together before seeing any
result), records the exchange in loop_messages
(replayed by the generator on the next iteration), and loops back to the
generator. Caller-defined tool calls are never executed here — they exit the
graph to the API caller as before.

What may execute is decided by state["builtin_tools"] — the set enabled for
THIS customer's request — not by whatever happens to be registered in the
process. Credentials for those tools are resolved once here, off the event
loop, and handed to the tools through ToolContext.secrets; they are never read
from process environment variables and never written into graph state, which
the durable runtime checkpoints to Postgres.

Mixed turns (built-in + caller-defined calls together) execute the built-in
subset and DROP the caller-defined calls from the recorded assistant turn, so
no dangling tool-call ids reach the vendors; the model re-issues caller tools
on the next iteration if it still needs them.
"""
import asyncio
import logging
import re
import time
import uuid

from encoding_library.observability import count, observe
from graph.fs_tools import SCRATCH_TAGS
from graph.state import RetrievalState
from graph.tool_credentials import resolve_tool_credentials_and_settings, secrets_accessor
from graph.tools_runtime import credential_refs_for, make_tool_context, tools_for
from graph_tools.base import ToolResult

logger = logging.getLogger(__name__)

# Scratch-FS key layout — must stay in sync with graph/fs_tools.py's docs.
_FS_PREFIX_TEMPLATE = "customers/{customer_id}/agent-fs/{namespace}/"

# A tool result longer than this (node config "max_tool_result_chars") is
# spilled: full content to the scratch FS, a structure-preserving excerpt into
# loop_messages. Bounds per-round context growth AND checkpoint size.
_DEFAULT_MAX_TOOL_RESULT_CHARS = 8_000

# Per-turn web-search budget (node config "max_web_searches"). Searches within
# budget run as issued. Once the turn's running total (scratch
# "web_search_calls", which survives durable resume) reaches it, fan-out stops
# paying: each LATER round still executes ONE web_search — so "refine and
# retry" always works and the model is never hard-stopped — while every other
# search call in that round is answered with the guidance below instead of
# hitting the search API. A round that crosses the boundary mid-round gets no
# such grace call: the model issued those parallel calls before seeing any
# budget message, so the extras are unrefined duplicates by construction. The
# worst case is budget + one search per remaining round, bounded by the
# graph's iteration limit — versus the unbounded N-per-round fan-out
# aggressive models otherwise produce.
_DEFAULT_MAX_WEB_SEARCHES = 3
_WEB_SEARCH_TOOL = "web_search"
# Must match WebSearchTool.credential_ref — the key under which the tool's
# credentials AND its customer settings live in CustomerToolCredentials.
_WEB_SEARCH_CREDENTIAL_REF = "WEB_SEARCH"

# HARD per-turn ceiling above which even the grace search is denied — the
# vendor-style cap (Anthropic max_uses / OpenAI max_tool_calls). Customer-set
# in Settings → Tools → Web Search (stored as the WEB_SEARCH item's settings
# "max_searches_per_turn", written by the proxy's tool-credentials API), node
# config "max_web_searches_hard" as fallback, then this default. Clamped so a
# malformed stored value can never disable search outright.
_DEFAULT_MAX_WEB_SEARCHES_HARD = 5
_HARD_CAP_BOUNDS = (1, 20)
# Keep in sync with the proxy's CustomerCredentialsService validation and the
# react app's WebSearchToolSettings card.
_MAX_SEARCHES_SETTING = "max_searches_per_turn"


def _hard_search_cap(config: dict, web_search_settings: dict | None) -> int:
    raw = (web_search_settings or {}).get(_MAX_SEARCHES_SETTING)
    if raw is None:
        raw = config.get("max_web_searches_hard")
    try:
        cap = int(raw) if raw is not None else _DEFAULT_MAX_WEB_SEARCHES_HARD
    except (TypeError, ValueError):
        cap = _DEFAULT_MAX_WEB_SEARCHES_HARD
    return max(_HARD_CAP_BOUNDS[0], min(cap, _HARD_CAP_BOUNDS[1]))


def _search_budget_exhausted_message(cap: int) -> str:
    """Returned once the HARD cap is hit — terminal for the turn, phrased like
    the Tavily 432 handling so the model stops calling instead of retrying."""
    return (
        f"Web search is no longer available this turn: the per-message search "
        f"limit ({cap}) has been reached. Do not call web_search again — "
        "further calls will not run. Answer now from the results you already "
        "have, noting any gaps."
    )


def _search_budget_skip_message(total: int) -> str:
    """Returned INSTEAD of search results once the budget is spent and the
    round's single grace search (if any) is taken."""
    return (
        f"Web search skipped — this turn has already used {total} web "
        "search(es). Review the results you already have before searching "
        "again. If a specific fact is still missing, issue ONE refined query "
        "naming exactly that fact — a single refined search per round will run."
    )


def _search_budget_note(total: int) -> str:
    """Appended to the results of an over-budget search that did run."""
    return (
        f"\n\n[Note: this turn has now used {total} web search(es). "
        "Consolidate — answer from the results you have unless a specific "
        "fact is still missing.]"
    )

_USAGE_KEYS = (
    "input_tokens", "output_tokens", "total_tokens",
    "cache_read_tokens", "cache_creation_tokens", "reasoning_tokens",
)


def _add_usage(total: dict | None, inc: dict | None) -> dict:
    return {k: (total or {}).get(k, 0) + (inc or {}).get(k, 0) for k in _USAGE_KEYS}


def _truncate_for_context(content: str, max_chars: int, note: str) -> str:
    """Head + tail excerpt with an elision marker. The tail is kept because
    rendered source lists put the citation instruction last and summaries/
    conclusions tend to live at the end; the head keeps the preamble and the
    first source headers. Messages are never dropped and tool_call_id pairing
    is untouched — only this content string shrinks."""
    head = content[: int(max_chars * 0.6)]
    tail = content[len(content) - int(max_chars * 0.25):]
    omitted = len(content) - len(head) - len(tail)
    return f"{head}\n\n[... {omitted} characters omitted. {note}]\n\n{tail}"


def _spill_oversized(
    content: str, tool_name: str, seq: int, max_chars: int,
    store, fs_prefix: str, fs_read_enabled: bool,
) -> tuple[str, tuple[str, int] | None]:
    """Spill one oversized result: full content to the scratch FS, excerpt for
    the context. Returns (replacement_content, (fs_path, size) | None).
    A failed store write degrades to excerpt-only — the context budget wins."""
    path = f"results/{tool_name}_{seq}.txt"
    data = content.encode("utf-8")
    try:
        store.put(f"{fs_prefix}{path}", data, "text/plain; charset=utf-8", tags=SCRATCH_TAGS)
    except Exception as e:
        logger.error("Spill of %s result failed — %s", tool_name, e, exc_info=True)
        return (
            _truncate_for_context(
                content, max_chars,
                "The full output could not be saved — work with this excerpt.",
            ),
            None,
        )
    if fs_read_enabled:
        note = (
            f"Full output saved to scratch file '{path}' — use "
            f'fs_read(path="{path}", offset=…) to read the rest.'
        )
    else:
        note = f"Full output saved to scratch file '{path}'."
    return _truncate_for_context(content, max_chars, note), (path, len(data))

# How much of each tool result to surface in the client's thinking panel. Web
# results carry several dated snippets, so this is generous — the model always
# sees the full untruncated content in loop_messages regardless.
_TRACE_TOOL_LIMIT = 600
_TRACE_TOTAL_LIMIT = 4000

_CITATION_INSTRUCTION = (
    "Cite each claim inline with the bracketed number shown next to the source "
    "you drew it from, e.g. [1] or [2][3]. Never write your own Sources or "
    "References section — the application renders the numbered source list to "
    "the user from these entries."
)

_CITATION_MARKER = re.compile(r"\[(\d{1,3})\]")


def _shift_markers(text: str, base: int, count: int) -> str:
    """Shift a tool's own inline [n] markers (tool-local numbering 1..count) by
    the turn-global base, so they keep pointing at the same entries after
    _render_sources renumbers the list. Today only spawn_agent returns content
    that already carries markers — a subagent report citing its own sources.
    Bracketed numbers outside 1..count are left alone: they can't be citations
    of this tool's sources."""
    if base <= 0 or count <= 0 or not text:
        return text

    def _sub(m):
        n = int(m.group(1))
        return f"[{n + base}]" if 1 <= n <= count else m.group(0)

    return _CITATION_MARKER.sub(_sub, text)


def _render_sources(preamble: str, sources: list, base_index: int) -> str:
    """Render a tool's structured sources into a numbered block the model reads.

    Numbering is turn-global (starts at base_index + 1) so inline [n] markers
    stay unique across several tool calls in one turn and line up with the
    web_sources the client renders as links. [n] markers already inside the
    preamble (a subagent report) are shifted to match."""
    lines: list[str] = []
    if preamble:
        lines.append(_shift_markers(preamble, base_index, len(sources)))
        lines.append("")
    for offset, s in enumerate(sources, start=1):
        header = f"[{base_index + offset}] {s.title} ({s.url})".rstrip()
        if s.published_date:
            header += f" — published {s.published_date}"
        lines.append(header)
        if s.content:
            lines.append(s.content)
        lines.append("")
    lines.append(_CITATION_INSTRUCTION)
    return "\n".join(lines).strip()


def _summarize(name: str, result, content: str) -> str:
    """One-line trace summary for a tool call — source titles when the tool
    cited any, otherwise a (generously truncated) slice of its text."""
    if result is not None and result.sources:
        titles = "; ".join(s.title for s in result.sources if s.title)
        return f"{name}: {len(result.sources)} source(s) — {titles}"[:_TRACE_TOOL_LIMIT]
    return f"{name}: {content[:_TRACE_TOOL_LIMIT]}"


def tool_executor(node_id: str | None = None):
    async def node(state: RetrievalState) -> dict:
        return await _execute(state, node_id)

    node.__name__ = "tool_executor"
    return node


async def _execute(state: RetrievalState, node_id: str | None) -> dict:
    calls = state.get("tool_calls") or []
    # Enabled for this request, resolved to instances. A name the model emitted
    # that is not enabled here is treated as caller-defined, exactly as before.
    by_name = {
        t.name: t
        for t in tools_for(state.get("builtin_tools") or [], state.get("customer_id"))
    }
    builtin_calls = [c for c in calls if c.get("name", "") in by_name]
    dropped = [c.get("name") for c in calls if c.get("name", "") not in by_name]
    if dropped:
        logger.warning(
            "Node tool_executor: dropping %d caller-defined call(s) %s from a mixed "
            "turn — the model may re-issue them after seeing the built-in results",
            len(dropped), dropped,
        )
    if not builtin_calls:
        logger.warning("Node tool_executor: routed here with no in-graph tool calls")
        return {"tool_calls": None}

    customer_id = state["customer_id"]
    logger.info(
        "Node tool_executor: START — customer=%s executing %s",
        customer_id, [c.get("name") for c in builtin_calls],
    )

    configs = state.get("node_configs", {})
    config = (configs.get(node_id) if node_id else None) or configs.get("TOOL_EXECUTOR") or {}
    max_result_chars = int(config.get("max_tool_result_chars") or _DEFAULT_MAX_TOOL_RESULT_CHARS)

    # One scratch-FS namespace per request, minted on the first executor round
    # and pinned in scratch so every later round — and every spawned subagent —
    # addresses the same space. Survives durable resume via the checkpoint.
    scratch_state = state.get("scratch") or {}
    fs_namespace = scratch_state.get("fs_namespace") or uuid.uuid4().hex
    fs_prefix = _FS_PREFIX_TEMPLATE.format(customer_id=customer_id, namespace=fs_namespace)
    agent_depth = int(state.get("agent_depth") or 0)

    # Resolve every credential this turn needs in one pass, off the event loop
    # (DynamoDB + KMS through boto3 are blocking, and this process serves every
    # tenant on a single loop). A failure here must not abort the turn: tools
    # degrade on an empty credential map, so the model still gets an answer it
    # can act on. The same read carries each tool's plain per-customer settings
    # (Settings → Tools), consumed by the budget planning below — on failure
    # they fall back to defaults like the credentials do.
    refs = credential_refs_for(by_name[c["name"]] for c in builtin_calls)
    resolved: dict[str, dict] = {}
    tool_settings: dict[str, dict] = {}
    if refs:
        try:
            resolved, tool_settings = await asyncio.to_thread(
                resolve_tool_credentials_and_settings, customer_id, refs
            )
        except Exception as e:
            count("tool_credential_resolution_total", status="error")
            logger.error(
                "Node tool_executor: could not resolve tool credentials %s for "
                "customer=%s — tools will run without them (%s)",
                sorted(refs), customer_id, e, exc_info=True,
            )
        else:
            count("tool_credential_resolution_total", status="ok")

    # Web-search budget: decide per call, in the model's call order, BEFORE
    # dispatch — deterministic regardless of concurrent execution order.
    # "run" executes normally, "note" executes with a consolidation note
    # appended (the one over-budget grace search a fresh round is allowed),
    # "skip" never reaches the search API and returns refine guidance, and
    # "exhausted" — past the HARD cap — returns a terminal message with no
    # grace at all, the vendor-style ceiling for pathological loops.
    search_budget = int(config.get("max_web_searches") or _DEFAULT_MAX_WEB_SEARCHES)
    hard_search_cap = _hard_search_cap(config, tool_settings.get(_WEB_SEARCH_CREDENTIAL_REF))
    prior_searches = int(scratch_state.get("web_search_calls") or 0)
    grace_available = prior_searches >= search_budget
    searches_run = 0
    call_modes: list[str] = []
    for call in builtin_calls:
        if call.get("name") != _WEB_SEARCH_TOOL:
            call_modes.append("run")
        elif prior_searches + searches_run >= hard_search_cap:
            call_modes.append("exhausted")
        elif prior_searches + searches_run < search_budget:
            call_modes.append("run")
            searches_run += 1
        elif grace_available:
            call_modes.append("note")
            searches_run += 1
            grace_available = False
        else:
            call_modes.append("skip")
    searches_after_round = prior_searches + searches_run
    denied = call_modes.count("skip") + call_modes.count("exhausted")
    if denied:
        logger.info(
            "Node tool_executor: web-search budget (soft=%d hard=%d) reached for "
            "customer=%s — %d of %d search call(s) denied this round (%d exhausted)",
            search_budget, hard_search_cap, customer_id,
            denied, denied + searches_run, call_modes.count("exhausted"),
        )

    context = make_tool_context(customer_id, secrets=secrets_accessor(resolved))

    async def _spawn(profile: dict, prompt: str) -> dict:
        # Imported lazily: subagent builds a child graph from llm_node + THIS
        # module, so a module-level import would be a cycle.
        from graph.subagent import run_subagent

        return await run_subagent(state, profile, prompt, agent_depth + 1)

    context.runtime.update({
        "fs_namespace": fs_namespace,
        "fs_prefix": fs_prefix,
        "depth": agent_depth,
        "subagents": config.get("subagents") or [],
        "spawn": _spawn,
        # Consent flag for memory tools (search_memories): mirrors the
        # request's governance decision so the tool can refuse on paths where
        # it is bound without consent (notably subagents, whose state pins
        # memory_enabled=False).
        "memory_enabled": bool(state.get("memory_enabled")),
        # Scope and usage-log keys for search_memories (see MemoryContext).
        "memory_context": state.get("memory_context"),
    })

    # The assistant turn that made the calls, replayed to the model next
    # iteration together with the results below.
    loop_messages: list[dict] = [{
        "role": "assistant",
        "content": state.get("generated_response") or "",
        "tool_calls": builtin_calls,
    }]
    artifacts: list[dict] = []
    summaries: list[str] = []
    # Turn-global citation numbering: sources already emitted by earlier
    # TOOL_EXECUTOR rounds this turn set the base, so [n] markers never collide
    # across rounds. tool_sources is a plain overwrite field (see state.py), so
    # `running` starts wherever the previous round left off.
    prior_sources: list[dict] = state.get("tool_sources") or []
    new_sources: list[dict] = []
    running = len(prior_sources)
    # Per-call breakdown for the thinking panel — one entry per call, distinct
    # from `summaries`/`new_sources` above which flatten the whole round into
    # one line / one list. Without this, three web_search calls in one round
    # are indistinguishable in the trace ("web_search, web_search, web_search"
    # with no query, no per-call source attribution).
    calls_trace: list[dict] = []

    async def _run_one(call: dict, mode: str = "run"):
        """Execute one call with per-call error isolation. Returns
        (result | None, error | None) — never raises, so one failing tool can
        neither stop the others nor abort the turn. mode "skip" short-circuits
        a budget-exhausted web_search without touching the search API; "note"
        executes but appends the consolidation note to the result."""
        name = call.get("name", "")
        if mode == "exhausted":
            count("tool_execution_total", status="budget_exhausted", tool=name)
            return ToolResult(content=_search_budget_exhausted_message(hard_search_cap)), None
        if mode == "skip":
            count("tool_execution_total", status="budget_skipped", tool=name)
            return ToolResult(content=_search_budget_skip_message(searches_after_round)), None
        start = time.perf_counter()
        try:
            result = await by_name[name].run(call.get("args") or {}, context)
            count("tool_execution_total", status="ok", tool=name)
            if mode == "note":
                result.content = (result.content or "") + _search_budget_note(searches_after_round)
            return result, None
        except Exception as e:
            count("tool_execution_total", status="error", tool=name)
            logger.error("Node tool_executor: %s failed — %s", name, e, exc_info=True)
            return None, str(e)
        finally:
            observe("tool_execution_duration_seconds", time.perf_counter() - start, tool=name)

    # All of a turn's calls run CONCURRENTLY — three web searches (or three
    # spawned subagents) take one round-trip, not three. Post-processing below
    # stays sequential in the model's call order, which is what keeps citation
    # numbering and loop_messages deterministic. EXCEPT on the durable /runs
    # path: DBOS memoizes steps by execution order, and concurrent children
    # make LLM-step order nondeterministic across a crash/resume — so durable
    # runs execute the calls sequentially (correctness over latency there).
    try:
        from graph.nodes.llm_node import _dbos_active

        durable = _dbos_active()
    except Exception:
        durable = False
    if durable:
        outcomes = [await _run_one(c, m) for c, m in zip(builtin_calls, call_modes)]
    else:
        outcomes = await asyncio.gather(
            *(_run_one(c, m) for c, m in zip(builtin_calls, call_modes))
        )

    # Accumulated across the round, merged into the update once at the end.
    round_scratch: dict = {}
    round_usage: dict | None = None
    spilled_files: dict[str, int] = {}
    fs_read_enabled = "fs_read" in by_name

    for seq, (call, (result, error)) in enumerate(zip(builtin_calls, outcomes), start=1):
        name = call.get("name", "")
        args = call.get("args") or {}
        call_sources_start = len(new_sources)
        if error is not None:
            content = f"Error executing {name}: {error}"
        else:
            content = result.content
            artifacts.extend(a.to_dict() for a in result.artifacts)
            if result.sources:
                # The host owns numbering and rendering — tools return a bare
                # preamble + structured sources (see ToolResult / Source).
                content = _render_sources(result.content, result.sources, running)
                for offset, s in enumerate(result.sources, start=1):
                    new_sources.append(
                        {"index": running + offset, "title": s.title, "url": s.url}
                    )
                running += len(result.sources)
            # Tool-declared state changes (todo list, fs index entries) and
            # LLM spend (a spawned subagent's) fold into the round's totals.
            for key, value in (result.state_patch or {}).items():
                if isinstance(value, dict) and isinstance(round_scratch.get(key), dict):
                    round_scratch[key] = {**round_scratch[key], **value}
                else:
                    round_scratch[key] = value
            if result.usage:
                round_usage = _add_usage(round_usage, result.usage)
            # Oversized results spill to the scratch FS: the model gets a
            # structure-preserving excerpt plus the path to the full output.
            if len(content) > max_result_chars:
                content, spilled = _spill_oversized(
                    content, name, seq, max_result_chars,
                    context.store, fs_prefix, fs_read_enabled,
                )
                if spilled:
                    spilled_files[spilled[0]] = spilled[1]
        loop_messages.append({
            "role": "tool",
            "tool_call_id": call.get("id", ""),
            "content": content,
        })
        summaries.append(_summarize(name, result, content))
        call_entry = {
            "name": name,
            "args": args,
            # This call's own slice of new_sources — reuses the already-numbered
            # entries above rather than re-deriving titles/urls from result.sources.
            "sources": new_sources[call_sources_start:],
            "artifacts": [a.to_dict() for a in result.artifacts] if result else [],
            "error": error,
        }
        if result is not None and result.details:
            # Structured extras (e.g. a subagent's own step trace) for the
            # thinking panel — never part of what the model sees.
            call_entry["details"] = result.details
        calls_trace.append(call_entry)

    logger.info(
        "Node tool_executor: END — %d call(s) executed, %d artifact(s), %d source(s)",
        len(builtin_calls), len(artifacts), len(new_sources),
    )
    # Scratch update: the FS namespace is pinned EVERY round (a spawned child
    # or a later round must address the same space even if nothing was written
    # yet), plus whatever the tools patched. fs_files merges over the prior
    # index — scratch's reducer is last-writer-wins per key, so the full
    # accumulated map is written each time, like tool_sources.
    if spilled_files:
        round_scratch["fs_files"] = {**round_scratch.get("fs_files", {}), **spilled_files}
    if "fs_files" in round_scratch:
        round_scratch["fs_files"] = {
            **(scratch_state.get("fs_files") or {}), **round_scratch["fs_files"],
        }
    if searches_run:
        # Running per-turn search total, read back by the next round's budget
        # planning. Written AFTER tool state_patches so no tool can reset it.
        round_scratch["web_search_calls"] = searches_after_round
    scratch_update = {"fs_namespace": fs_namespace, **round_scratch}
    trace_entry = {
        "node": "TOOL_EXECUTOR",
        "prompt": ", ".join(c.get("name", "") for c in builtin_calls),
        "response": "\n".join(summaries)[:_TRACE_TOTAL_LIMIT],
        "calls": calls_trace,
    }
    if "todos" in round_scratch:
        # The round updated the plan — surface the current checklist on this
        # step so the streaming layer can emit it (and the proxy persist it)
        # with the turn's thinking content.
        trace_entry["todos"] = round_scratch["todos"]
    update: dict = {
        "loop_messages": loop_messages,
        "generated_artifacts": artifacts,
        # Consumed: the next generator run decides whether more calls are needed.
        "tool_calls": None,
        # Cleared so a failing follow-up generation can't surface the pre-tool
        # preamble as if it were the final answer.
        "generated_response": None,
        "scratch": scratch_update,
        "trace": [trace_entry],
    }
    if round_usage:
        # LLM spend incurred INSIDE tools (spawned subagents) joins the run's
        # usage channel — the reducer accumulates it with the nodes' own.
        update["usage"] = round_usage
    if new_sources:
        # Full accumulated snapshot (prior + this round) with turn-global
        # indices, so the streaming layer emits the complete citable set in one
        # web_sources event and the proxy's last-write-wins capture keeps all of
        # it across multiple search rounds.
        update["tool_sources"] = prior_sources + new_sources
    return update
