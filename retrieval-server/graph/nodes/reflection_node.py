import json
import logging
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from graph.llm_factory import get_llm
from graph.nodes.llm_node import _render_template
from graph.state import RetrievalState

logger = logging.getLogger(__name__)

_DEFAULT_SYSTEM_PROMPT = """You are a helpful AI assistant. Answer the user's question using the provided context.
Be concise, accurate, and helpful.

You MUST respond with valid JSON in this exact format:
{"answer": "<your answer here>", "needs_more_context": <true|false>}

Set needs_more_context to true ONLY if the provided context is clearly insufficient to answer
the question at all. If you can give a reasonable answer, set it to false."""

_DEFAULT_INPUT_TEMPLATE = "Context:\n{context}\n\nQuestion: {query}"


def make_reflection_node(node_type: str):
    """
    Platform node for graphs with cycles.

    Like make_llm_node with response_format=json, but with a hard guarantee:
    needs_more_context is ALWAYS written to state (defaulting to False on any
    failure) so a cycle using this node always has a safe exit path.

    Configurable via DDB node config:
      system_prompt   (str)  — must instruct the LLM to return the required JSON schema
      input_template  (str)  — {context}, {query} and other state placeholders
      output_key      (str)  — state field for the answer (default: generated_response)
      model_override  (str)  — override request-level model
      include_conversation_history (bool)
    """
    async def node(state: RetrievalState) -> dict:
        config = state.get("node_configs", {}).get(node_type, {})
        system_prompt = config.get("system_prompt", _DEFAULT_SYSTEM_PROMPT)
        input_template = config.get("input_template", _DEFAULT_INPUT_TEMPLATE)
        output_key = config.get("output_key", "generated_response")
        include_history: bool = config.get("include_conversation_history", False)
        model_override: str | None = config.get("model_override")

        effective_model = model_override or state.get("llm_model")
        llm = get_llm(
            state["llm_provider"],
            state["llm_credentials"],
            effective_model,
            state.get("llm_max_tokens", 4096),
        )

        messages: list[Any] = [SystemMessage(content=system_prompt)]

        if include_history:
            history = state.get("conversation_history", [])
            for turn in (history[:-1] if history else []):
                role = turn.get("role", "user")
                content = turn.get("content", "")
                messages.append(HumanMessage(content=content) if role == "user" else AIMessage(content=content))

        messages.append(HumanMessage(content=_render_template(input_template, state)))

        logger.info("Node %s (reflection): calling LLM model=%s", node_type, effective_model)
        response = await llm.ainvoke(messages)

        meta = getattr(response, "usage_metadata", None) or {}
        usage = {
            "input_tokens": meta.get("input_tokens", 0),
            "output_tokens": meta.get("output_tokens", 0),
            "total_tokens": meta.get("total_tokens", 0),
        }

        try:
            parsed = json.loads(response.content)
            needs_more = bool(parsed.get("needs_more_context", False))
            logger.info("Node %s: needs_more_context=%s", node_type, needs_more)
            return {
                output_key: parsed.get("answer", ""),
                "needs_more_context": needs_more,
                "usage": usage,
            }
        except (json.JSONDecodeError, Exception) as e:
            # Always exit the cycle safely on parse failure — never leave
            # needs_more_context unset or True from a previous iteration.
            logger.error("Node %s: JSON parse failed (%s) — exiting cycle safely", node_type, e)
            return {
                output_key: response.content,
                "needs_more_context": False,
                "usage": usage,
            }

    node.__name__ = f"reflection_node_{node_type.lower()}"
    return node
