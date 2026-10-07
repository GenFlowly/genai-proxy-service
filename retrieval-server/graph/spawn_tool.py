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

from graph_tools.base import Artifact, GraphTool, ToolContext, ToolResult

logger = logging.getLogger(__name__)

# Keep a child's step trace bounded in the parent's trace payload.
_MAX_CHILD_TRACE_ENTRIES = 30


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
        "required": ["prompt"],
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
        return ToolResult(
            content=f"Report from the '{name}' subagent:\n\n{out['content']}",
            usage=out.get("usage"),
            artifacts=artifacts,
            details=details,
        )
