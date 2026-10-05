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
import time

from encoding_library.observability import count, observe
from graph.state import RetrievalState
from graph.tool_credentials import resolve_tool_credentials, secrets_accessor
from graph.tools_runtime import credential_refs_for, make_tool_context, tools_for

logger = logging.getLogger(__name__)

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
        neither stop the others nor abort the turn."""
        name = call.get("name", "")
        start = time.perf_counter()
        try:
            result = await by_name[name].run(call.get("args") or {}, context)
            count("tool_execution_total", status="ok", tool=name)
            return result, None
        except Exception as e:
            count("tool_execution_total", status="error", tool=name)
            logger.error("Node tool_executor: %s failed — %s", name, e, exc_info=True)
            return None, str(e)
        finally:
            observe("tool_execution_duration_seconds", time.perf_counter() - start, tool=name)

    # All of a turn's calls run CONCURRENTLY — three web searches (or three
    # spawned sub-runs, once that tool exists) take one round-trip, not three.
    # Post-processing below stays sequential in the model's call order, which
    # is what keeps citation numbering and loop_messages deterministic.
    outcomes = await asyncio.gather(*(_run_one(c) for c in builtin_calls))

    for call, (result, error) in zip(builtin_calls, outcomes):
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
        loop_messages.append({
            "role": "tool",
            "tool_call_id": call.get("id", ""),
            "content": content,
        })
        summaries.append(_summarize(name, result, content))
        calls_trace.append({
            "name": name,
            "args": args,
            # This call's own slice of new_sources — reuses the already-numbered
            # entries above rather than re-deriving titles/urls from result.sources.
            "sources": new_sources[call_sources_start:],
            "artifacts": [a.to_dict() for a in result.artifacts] if result else [],
            "error": error,
        })

    logger.info(
        "Node tool_executor: END — %d call(s) executed, %d artifact(s), %d source(s)",
        len(builtin_calls), len(artifacts), len(new_sources),
    )
    update: dict = {
        "loop_messages": loop_messages,
        "generated_artifacts": artifacts,
        # Consumed: the next generator run decides whether more calls are needed.
        "tool_calls": None,
        # Cleared so a failing follow-up generation can't surface the pre-tool
        # preamble as if it were the final answer.
        "generated_response": None,
        "trace": [{
            "node": "TOOL_EXECUTOR",
            "prompt": ", ".join(c.get("name", "") for c in builtin_calls),
            "response": "\n".join(summaries)[:_TRACE_TOTAL_LIMIT],
            "calls": calls_trace,
        }],
    }
    if new_sources:
        # Full accumulated snapshot (prior + this round) with turn-global
        # indices, so the streaming layer emits the complete citable set in one
        # web_sources event and the proxy's last-write-wins capture keeps all of
        # it across multiple search rounds.
        update["tool_sources"] = prior_sources + new_sources
    return update
