"""TOOL_EXECUTOR node: executes built-in tool calls inside the graph.

The response generator binds built-in tools (see llm_node) and may answer with
tool_calls. A "tool_route" conditional edge sends built-in calls here; this
node executes them via the graph_tools registry, records the exchange in
loop_messages (replayed by the generator on the next iteration), and loops
back to the generator. Caller-defined tool calls are never executed here —
they exit the graph to the API caller as before.

Mixed turns (built-in + caller-defined calls together) execute the built-in
subset and DROP the caller-defined calls from the recorded assistant turn, so
no dangling tool-call ids reach the vendors; the model re-issues caller tools
on the next iteration if it still needs them.
"""
import logging

from graph.state import RetrievalState
from graph.tools_runtime import get_registry, make_tool_context

logger = logging.getLogger(__name__)


def tool_executor(node_id: str | None = None):
    async def node(state: RetrievalState) -> dict:
        return await _execute(state, node_id)

    node.__name__ = "tool_executor"
    return node


async def _execute(state: RetrievalState, node_id: str | None) -> dict:
    calls = state.get("tool_calls") or []
    registry = get_registry()
    builtin_calls = [c for c in calls if registry.has(c.get("name", ""))]
    dropped = [c.get("name") for c in calls if not registry.has(c.get("name", ""))]
    if dropped:
        logger.warning(
            "Node tool_executor: dropping %d caller-defined call(s) %s from a mixed "
            "turn — the model may re-issue them after seeing the built-in results",
            len(dropped), dropped,
        )
    if not builtin_calls:
        logger.warning("Node tool_executor: routed here with no built-in tool calls")
        return {"tool_calls": None}

    customer_id = state["customer_id"]
    logger.info(
        "Node tool_executor: START — customer=%s executing %s",
        customer_id, [c.get("name") for c in builtin_calls],
    )
    context = make_tool_context(customer_id)

    # The assistant turn that made the calls, replayed to the model next
    # iteration together with the results below.
    loop_messages: list[dict] = [{
        "role": "assistant",
        "content": state.get("generated_response") or "",
        "tool_calls": builtin_calls,
    }]
    artifacts: list[dict] = []
    summaries: list[str] = []

    for call in builtin_calls:
        name = call.get("name", "")
        try:
            result = await registry.get(name).run(call.get("args") or {}, context)
            content = result.content
            artifacts.extend(a.to_dict() for a in result.artifacts)
        except Exception as e:
            logger.error("Node tool_executor: %s failed — %s", name, e, exc_info=True)
            content = f"Error executing {name}: {e}"
        loop_messages.append({
            "role": "tool",
            "tool_call_id": call.get("id", ""),
            "content": content,
        })
        summaries.append(f"{name}: {content[:200]}")

    logger.info(
        "Node tool_executor: END — %d call(s) executed, %d artifact(s) produced",
        len(builtin_calls), len(artifacts),
    )
    return {
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
            "response": "\n".join(summaries)[:1500],
        }],
    }
