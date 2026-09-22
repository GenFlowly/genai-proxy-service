"""TOOL_EXECUTOR node: executes backend tool calls inside the graph.

The response generator binds the tools enabled for this request (see llm_node)
and may answer with tool_calls. A "tool_route" conditional edge sends in-graph
calls here; this node executes them, records the exchange in loop_messages
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

    for call in builtin_calls:
        name = call.get("name", "")
        start = time.perf_counter()
        try:
            result = await by_name[name].run(call.get("args") or {}, context)
            content = result.content
            artifacts.extend(a.to_dict() for a in result.artifacts)
            count("tool_execution_total", status="ok", tool=name)
        except Exception as e:
            count("tool_execution_total", status="error", tool=name)
            logger.error("Node tool_executor: %s failed — %s", name, e, exc_info=True)
            content = f"Error executing {name}: {e}"
        observe("tool_execution_duration_seconds", time.perf_counter() - start, tool=name)
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
