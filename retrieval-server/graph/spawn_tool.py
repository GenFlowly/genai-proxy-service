"""spawn_agent: delegate a task to a subagent running its own agent loop.

The tool that turns the single agent loop into every multi-agent pattern:
the model decomposes work at runtime and spawns children per subtask —
orchestrator/worker, parallel fan-out (several calls in one turn run
concurrently on the stateless path), judge/critique (spawn a reviewer) — with
no topology declared anywhere. See graph/subagent.py for the child runtime and
the context-isolation rationale.

Profiles come from the TOOL_EXECUTOR node config ("subagents", data in DDB);
the available profile names/descriptions are listed in the calling model's
system prompt (llm_node appends them when this tool is bound). The host
injects the actual spawn callable and nesting depth through ToolContext.runtime
— this tool itself holds no execution machinery, so it stays trivially
testable and the depth/budget policy stays in one place.
"""
import logging
import re

from graph_tools.base import Artifact, GraphTool, Source, ToolContext, ToolResult

logger = logging.getLogger(__name__)

# Keep a child's step trace bounded in the parent's trace payload.
_MAX_CHILD_TRACE_ENTRIES = 30

# Same shape streaming.py matches when trimming the panel to cited entries.
_CITATION_MARKER = re.compile(r"\[(\d{1,3})\]")


def _cited_sources(report: str, child_sources: list) -> tuple[str, list[Source]]:
    """The child's web sources as this tool's ToolResult sources: trimmed to
    the entries the report actually cites, the report's [n] markers compacted
    to 1..k over the kept list.

    The child numbered its sources for its OWN turn; the parent's executor
    renumbers whatever a tool returns into the PARENT's turn-global sequence
    and shifts the content's markers to match (_render_sources), but both
    assume the tool-local numbering is 1..len(sources) — which compacting here
    guarantees. Without this fold, a delegating turn ends with no structured
    sources for the subagents' evidence, and the model compensates by
    hand-writing its own Sources section — which the client then renders next
    to the real panel (the double-"Sources" bug).

    A report that cites nothing keeps the child's full source list (the same
    full-provenance rule as streaming's end-of-turn trim). Titles and urls
    only, no snippets — the report itself is the content."""
    by_index = {s.get("index"): s for s in child_sources if s.get("index")}
    cited = sorted({int(n) for n in _CITATION_MARKER.findall(report)} & by_index.keys())
    if cited:
        remap = {old: new for new, old in enumerate(cited, start=1)}
        report = _CITATION_MARKER.sub(
            lambda m: f"[{remap[int(m.group(1))]}]" if int(m.group(1)) in remap else m.group(0),
            report,
        )
        kept = [by_index[i] for i in cited]
    else:
        kept = child_sources
    return report, [Source(title=s.get("title", ""), url=s.get("url", "")) for s in kept]


class SpawnAgentTool(GraphTool):
    name = "spawn_agent"
    credential_ref = None
    description = (
        "Delegate a self-contained task to a subagent that works autonomously "
        "with its own tools and returns one final report. The subagent sees "
        "ONLY the prompt you write — none of this conversation — so include "
        "every fact, constraint, and desired output format the task needs. "
        "Use it to parallelize independent subtasks (make several spawn_agent "
        "calls in one turn), to run a deep investigation without flooding "
        "this conversation, or to get work checked by a reviewer. Your system "
        "prompt lists the available agent types; omit agent_type for the "
        "general-purpose agent. Do not delegate trivial single-step work."
    )
    parameters = {
        "type": "object",
        "properties": {
            "purpose": {
                "type": "string",
                "description": (
                    "One short sentence for the user: what this delegated task "
                    "should find out and why you need it."
                ),
            },
            "prompt": {
                "type": "string",
                "description": (
                    "The complete, self-contained task: context, constraints, "
                    "and the exact form the answer should take."
                ),
            },
            "agent_type": {
                "type": "string",
                "description": (
                    "Which agent profile to run (see the list in your system "
                    "prompt). Omit for 'general'."
                ),
            },
        },
        "required": ["purpose", "prompt"],
    }

    async def run(self, args: dict, context: ToolContext) -> ToolResult:
        from graph.subagent import MAX_DEPTH, resolve_profile

        prompt = (args.get("prompt") or "").strip()
        if not prompt:
            return ToolResult(content="Error: prompt is empty — describe the task.")

        depth = int(context.runtime.get("depth") or 0)
        if depth >= MAX_DEPTH:
            return ToolResult(
                content=(
                    "Error: the subagent nesting limit is reached — do this "
                    "task yourself with your own tools."
                )
            )

        spawn = context.runtime.get("spawn")
        if spawn is None:
            return ToolResult(
                content="Error: subagents are not available in this run."
            )

        agent_type = (args.get("agent_type") or "").strip() or None
        profile = resolve_profile(context.runtime.get("subagents"), agent_type)
        if profile is None:
            known = ", ".join(
                p.get("name", "?") for p in context.runtime.get("subagents") or []
            )
            return ToolResult(
                content=(
                    f"Error: unknown agent_type '{agent_type}'. Available: "
                    f"{known or 'general'} (or omit agent_type for general)."
                )
            )

        out = await spawn(profile, prompt)

        name = profile.get("name", "general")
        details = {
            "subagent": name,
            "subagent_trace": (out.get("trace") or [])[:_MAX_CHILD_TRACE_ENTRIES],
        }
        artifacts = [Artifact(**a) for a in out.get("artifacts") or []]

        if out.get("error") and not out.get("content"):
            return ToolResult(
                content=(
                    f"The '{name}' subagent failed before producing a report "
                    f"({out['error']}). Retry with a narrower task, or do the "
                    "work yourself with your own tools."
                ),
                usage=out.get("usage"),
                details=details,
            )
        if not out.get("content"):
            return ToolResult(
                content=(
                    f"The '{name}' subagent finished without a report. Retry "
                    "with a more specific prompt, or do the work yourself."
                ),
                usage=out.get("usage"),
                details=details,
            )
        report, sources = _cited_sources(out["content"], out.get("sources") or [])
        return ToolResult(
            content=f"Report from the '{name}' subagent:\n\n{report}",
            usage=out.get("usage"),
            artifacts=artifacts,
            sources=sources,
            details=details,
        )
