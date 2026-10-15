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
import dataclasses
import logging
import time
import uuid

import durable_metrics
import durable_runtime
import tool_ledger
from encoding_library.observability import count, observe
from graph.state import RetrievalState
from graph.tool_credentials import resolve_tool_credentials, secrets_accessor
from graph.tools_runtime import credential_refs_for, make_tool_context, tools_for

logger = logging.getLogger(__name__)

# Scratch-FS key layout — must stay in sync with graph/fs_tools.py's docs.
_FS_PREFIX_TEMPLATE = "customers/{customer_id}/agent-fs/{namespace}/"

# A tool result longer than this (node config "max_tool_result_chars") is
# spilled: full content to the scratch FS, a structure-preserving excerpt into
# loop_messages. Bounds per-round context growth AND checkpoint size.
_DEFAULT_MAX_TOOL_RESULT_CHARS = 8_000

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
        store.put(f"{fs_prefix}{path}", data, "text/plain; charset=utf-8")
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
    "you drew it from, e.g. [1] or [2][3]."
)


def _render_sources(preamble: str, sources: list, base_index: int) -> str:
    """Render a tool's structured sources into a numbered block the model reads.

    Numbering is turn-global (starts at base_index + 1) so inline [n] markers
    stay unique across several tool calls in one turn and line up with the
    web_sources the client renders as links."""
    lines: list[str] = []
    if preamble:
        lines.append(preamble)
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


# --- Durable runs: tool calls as memoized DBOS steps (plan 0.4) --------------
# A re-executed run (DBOS recovery after a crash) replays from START. Each call
# that completed before the crash returns its recorded result from the step
# memo and is not run again; the call that was in flight has no memo, and the
# attempt ledger (tool_ledger.py) refuses to run it a second time.
# Composite tools are not wrapped: spawn_agent runs a whole child loop whose
# LLM and tool calls are steps of their own, and a step called inside a step
# runs as a plain function — the child's memos would be lost.
_COMPOSITE_TOOLS = frozenset({"spawn_agent"})
# Namespace of the scratch-FS namespace derived from a durable run's id.
_FS_NAMESPACE_UUID = uuid.UUID("8d4b1f0e-6c2a-4f7e-b3d5-2a9c0e7f1b64")


async def _invoke_with_ledger(tool, call: dict, context, workflow_id: str, function_id: int):
    """The tool_invoke step body, plain so it can be tested without DBOS.
    Returns (result | None, error | None) like _run_one; raises only
    tool_ledger.ReplayDivergence. Ledger rows carry ids, never arguments."""
    name = call.get("name", "")
    call_id = call.get("id") or ""
    attempt = await tool_ledger.begin(workflow_id, function_id, call_id, name, context.customer_id)
    if not attempt.run:
        durable_metrics.tool_call_interrupted(name)
        logger.warning(
            "Node tool_executor: not re-running a tool call a restart interrupted — "
            "workflow=%s step=%s tool=%s attempt=%d",
            workflow_id, function_id, name, attempt.attempt,
        )
        return None, tool_ledger.INTERRUPTED_MESSAGE
    # Per-call artifact seed: a re-executed call would write the same object
    # keys (uuid5), never a second, unlinked copy.
    call_context = dataclasses.replace(
        context, artifact_seed=f"{context.customer_id}:{workflow_id}:{function_id}:{call_id}",
    )
    try:
        result = await tool.run(call.get("args") or {}, call_context)
    except Exception as e:
        await _finish_attempt(workflow_id, function_id, attempt.attempt, tool_ledger.FAILED, type(e).__name__)
        logger.error("Node tool_executor: %s failed — %s", name, e, exc_info=True)
        return None, str(e)
    await _finish_attempt(workflow_id, function_id, attempt.attempt, tool_ledger.FINISHED)
    return result, None


async def _finish_attempt(workflow_id, function_id, attempt, status, error_class=None) -> None:
    try:
        await tool_ledger.finish(workflow_id, function_id, attempt, status, error_class)
    except Exception:
        # Not fatal: the step memo records the outcome, and on a re-execution
        # any earlier attempt — finished or not — refuses the call anyway.
        logger.warning(
            "Node tool_executor: could not record attempt %d of workflow=%s step=%s as %s",
            attempt, workflow_id, function_id, status, exc_info=True,
        )


if durable_runtime.dbos_constructed():
    from dbos import DBOS
    from dbos import error as dbos_errors

    # Raised when a replay does not follow the recorded step order. Never
    # turned into a tool error: the run must fail, not continue on a
    # misaligned memo.
    _REPLAY_ERRORS = (
        tool_ledger.ReplayDivergence,
        dbos_errors.DBOSUnexpectedStepError,
        dbos_errors.DBOSStepNondeterminismError,
    )

    @DBOS.step(name="tool_invoke")
    async def _durable_tool_invoke(tool, call: dict, context):
        return await _invoke_with_ledger(tool, call, context, DBOS.workflow_id, DBOS.step_id)
else:
    _REPLAY_ERRORS = (tool_ledger.ReplayDivergence,)
    _durable_tool_invoke = None


def _durable_workflow_id() -> str | None:
    """The DBOS workflow id while executing inside a durable run, else None."""
    if _durable_tool_invoke is None:
        return None
    return DBOS.workflow_id


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
    # addresses the same space. A durable run derives it from its workflow id:
    # a re-execution replays from a fresh checkpoint, and must address the
    # space its memoized fs_write calls wrote to.
    durable_workflow_id = _durable_workflow_id()
    scratch_state = state.get("scratch") or {}
    fs_namespace = scratch_state.get("fs_namespace") or (
        uuid.uuid5(_FS_NAMESPACE_UUID, durable_workflow_id).hex
        if durable_workflow_id else uuid.uuid4().hex
    )
    fs_prefix = _FS_PREFIX_TEMPLATE.format(customer_id=customer_id, namespace=fs_namespace)
    agent_depth = int(state.get("agent_depth") or 0)

    # Resolve every credential this turn needs in one pass, off the event loop
    # (DynamoDB + KMS through boto3 are blocking, and this process serves every
    # tenant on a single loop). A failure here must not abort the turn: tools
    # degrade on an empty credential map, so the model still gets an answer it
    # can act on.
    refs = credential_refs_for(by_name[c["name"]] for c in builtin_calls)
    resolved: dict[str, dict] = {}
    if refs:
        try:
            resolved = await asyncio.to_thread(
                resolve_tool_credentials, customer_id, refs
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

    async def _run_one(call: dict):
        """Execute one call with per-call error isolation. Returns
        (result | None, error | None) — never raises, so one failing tool can
        neither stop the others nor abort the turn. The exception: on the
        durable path (a memoized tool_invoke step, plan 0.4) a replay that
        does not follow the recorded step order must fail the run."""
        name = call.get("name", "")
        start = time.perf_counter()
        try:
            if durable_workflow_id and name not in _COMPOSITE_TOOLS:
                result, error = await _durable_tool_invoke(by_name[name], call, context)
                if error is not None:
                    count("tool_execution_total", status="error", tool=name)
                    return None, error
            else:
                result = await by_name[name].run(call.get("args") or {}, context)
            count("tool_execution_total", status="ok", tool=name)
            return result, None
        except _REPLAY_ERRORS:
            raise
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
        outcomes = [await _run_one(c) for c in builtin_calls]
    else:
        outcomes = await asyncio.gather(*(_run_one(c) for c in builtin_calls))

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
