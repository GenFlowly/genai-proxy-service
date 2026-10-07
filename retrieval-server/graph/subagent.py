"""Child agent-loop runner — the engine behind the spawn_agent tool.

A subagent is NOT a new runtime: it is the same generator ⇄ TOOL_EXECUTOR loop
every agent graph runs, compiled once here as a static two-node workflow and
invoked with a fresh child state. That buys the two properties that make
delegation work:

  * Context isolation — the child starts from ONLY the delegated prompt (no
    parent conversation, no parent loop messages) and the parent receives one
    string back: the child's final answer. A child can burn 40 tool rounds of
    intermediate noise without any of it entering the parent's context.
  * Uniformity — the child goes through the same llm_node and tool_executor,
    so durable LLM steps, credential resolution, usage metering, budgets and
    compaction all apply unchanged at every depth.

Profiles (which tools, which persona/instruction, which model) are DATA — they
live in the TOOL_EXECUTOR node config's "subagents" list, exactly like Claude
Code's agent definitions live in editable files, with GENERAL_PROFILE as the
built-in default. The scratch filesystem namespace is shared down the tree, so
a child can leave files the parent then reads.

Import note: tool_executor imports this module lazily (inside the node
function), so the module-level imports here never form an import cycle.
"""
import logging

from langgraph.graph import END, StateGraph

from graph.state import RetrievalState

logger = logging.getLogger(__name__)

_GENERATOR_ID = "subagent_generator"
_EXECUTOR_ID = "subagent_tools"

# Hard ceiling on nesting: the root run is depth 0, its children depth 1, and
# a depth-1 child may spawn depth-2 workers; depth 2 may not spawn at all.
MAX_DEPTH = 2

DEFAULT_SUBAGENT_TOOLS = [
    "search_knowledge_base", "web_search", "fs_write", "fs_read", "fs_list",
    "write_todos",
]

# The built-in default profile, always available (Claude Code's
# "general-purpose" analog). Customer-configured profiles extend, never
# replace, this one.
GENERAL_PROFILE = {
    "name": "general",
    "description": (
        "General-purpose agent for research and multi-step work over the "
        "knowledge base and the web. Use when no specialist profile fits."
    ),
    "tools": DEFAULT_SUBAGENT_TOOLS,
}

_DEFAULT_CHILD_MAX_ITERATIONS = 24
_DEFAULT_CHILD_MAX_TURN_TOKENS = 30_000

_DEFAULT_CHILD_HARNESS = (
    "You are a subagent working on one delegated task. Your final message is "
    "returned verbatim to the agent that delegated to you — it is NOT shown "
    "to the end user — so make it a complete, self-contained report of what "
    "you found or produced: the delegator sees nothing of your intermediate "
    "work. Be thorough in your research but distilled in your answer. If you "
    "cannot complete the task, say exactly what you tried and what is missing."
)

_child_graph = None


def _get_child_graph():
    """The compiled two-node child loop, built once per process. Imports are
    deferred to keep module import light and cycle-free."""
    global _child_graph
    if _child_graph is None:
        from graph.dynamic_graph import _make_condition_router
        from graph.nodes.llm_node import make_llm_node
        from graph.nodes.tool_executor import tool_executor

        builder = StateGraph(RetrievalState)
        builder.add_node(_GENERATOR_ID, make_llm_node("RESPONSE_GENERATOR", _GENERATOR_ID))
        builder.add_node(_EXECUTOR_ID, tool_executor(_EXECUTOR_ID))
        builder.set_entry_point(_GENERATOR_ID)
        builder.add_conditional_edges(
            _GENERATOR_ID,
            _make_condition_router(
                {"condition_type": "tool_route"},
                {"builtin": _EXECUTOR_ID, "caller": END, "none": END},
            ),
        )
        builder.add_edge(_EXECUTOR_ID, _GENERATOR_ID)
        _child_graph = builder.compile()
    return _child_graph


def resolve_profile(profiles: list | None, agent_type: str | None) -> dict | None:
    """The configured profile named agent_type; the built-in general profile
    for no/`general` type; None for an unknown name (the tool reports it)."""
    for profile in profiles or []:
        if isinstance(profile, dict) and profile.get("name") == agent_type:
            return profile
    if not agent_type or agent_type == "general":
        return GENERAL_PROFILE
    return None


def _profile_persona(profile: dict) -> str | None:
    """The profile's persona text: inline `prompt` first, else its instruction
    record (same precedence instructions have elsewhere)."""
    persona = profile.get("prompt")
    if persona:
        return persona
    instruction_id = profile.get("instruction_id")
    if instruction_id:
        from graph.instruction_loader import get_instruction_text

        version = profile.get("instruction_version")
        return get_instruction_text(
            instruction_id, int(version) if version is not None else None
        )
    return None


async def run_subagent(
    parent_state: RetrievalState, profile: dict, prompt: str, depth: int
) -> dict:
    """Run one child loop to completion.

    Returns {"content", "usage", "trace", "artifacts", "error"} — never
    raises, so a failed child becomes an actionable tool result for the
    parent model rather than an aborted parent turn.
    """
    tools = [t for t in (profile.get("tools") or DEFAULT_SUBAGENT_TOOLS) if t]
    if depth >= MAX_DEPTH:
        # Depth cap is enforced by the spawn tool before calling here too;
        # stripping spawn_agent from the leaf's toolset is the belt to that
        # suspender.
        tools = [t for t in tools if t != "spawn_agent"]

    child_configs = {
        _GENERATOR_ID: {
            "output_key": "generated_response",
            "response_format": "text",
            "input_template": "{original_query}",
            "include_conversation_history": False,
            "harness_prompt": profile.get("harness_prompt") or _DEFAULT_CHILD_HARNESS,
            "max_turn_tokens": int(
                profile.get("max_turn_tokens") or _DEFAULT_CHILD_MAX_TURN_TOKENS
            ),
        },
        _EXECUTOR_ID: {
            "tools": tools,
            "subagents": profile.get("subagents") or [],
        },
    }

    child_state: dict = {
        # Identity / metering — the child is the same tenant and request source.
        "customer_id": parent_state["customer_id"],
        "client": parent_state.get("client", ""),
        "data_type": parent_state.get("data_type", ""),
        "request_source": parent_state.get("request_source") or "conversation",
        "model_type": parent_state.get("model_type"),
        "model_name": parent_state.get("model_name"),
        # The delegated task IS the child's whole world: no parent history.
        "original_query": prompt,
        "rewritten_query": None,
        "needs_rewrite": False,
        "query_intent": None,
        "top_n": parent_state.get("top_n", 5),
        "search_params": parent_state.get("search_params") or {},
        "similarity_threshold": parent_state.get("similarity_threshold", 0.6),
        "llm_credentials": parent_state.get("llm_credentials") or {},
        "llm_provider": parent_state["llm_provider"],
        "llm_model": profile.get("model") or parent_state.get("llm_model"),
        "llm_max_tokens": parent_state.get("llm_max_tokens"),
        "conversation_history": [],
        "query_images": [],
        "tools": [],
        "tool_choice": None,
        "query_tool_results": [],
        "builtin_tools": tools,
        "loop_messages": [],
        "generated_artifacts": [],
        "tool_sources": [],
        "response_schema": None,
        "node_configs": child_configs,
        "request_system_prompt": _profile_persona(profile),
        "retrieval_results": [],
        "ranked_results": [],
        "web_search_results": [],
        "web_search_answer": None,
        "usage": {
            "input_tokens": 0, "output_tokens": 0, "total_tokens": 0,
            "cache_read_tokens": 0, "cache_creation_tokens": 0,
            "reasoning_tokens": 0,
        },
        "memory_enabled": False,  # learned user memories are the root agent's
        "memories_block": None,
        "trace": [],
        # Share the parent's scratch-FS namespace so files flow down AND up
        # the agent tree (a child's report can say "details in fs://…").
        "scratch": (
            {"fs_namespace": parent_state.get("scratch", {}).get("fs_namespace")}
            if parent_state.get("scratch", {}).get("fs_namespace")
            else {}
        ),
        "generated_response": None,
        "tool_calls": None,
        "error": None,
        "agent_depth": depth,
    }

    recursion_limit = int(profile.get("max_iterations") or _DEFAULT_CHILD_MAX_ITERATIONS)
    logger.info(
        "Subagent '%s' START — depth=%d tools=%s prompt='%s'",
        profile.get("name"), depth, tools, prompt[:120],
    )
    try:
        result = await _get_child_graph().ainvoke(
            child_state, config={"recursion_limit": recursion_limit}
        )
    except Exception as e:
        logger.error("Subagent '%s' FAILED — %s", profile.get("name"), e, exc_info=True)
        return {
            "content": "",
            "usage": None,
            "trace": [],
            "artifacts": [],
            "error": f"{type(e).__name__}: {e}",
        }
    logger.info(
        "Subagent '%s' END — usage=%s", profile.get("name"), result.get("usage"),
    )
    return {
        "content": result.get("generated_response") or "",
        "usage": result.get("usage"),
        "trace": result.get("trace") or [],
        "artifacts": result.get("generated_artifacts") or [],
        "error": result.get("error"),
    }
