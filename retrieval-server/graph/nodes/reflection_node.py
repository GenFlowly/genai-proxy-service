import json
import logging
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from graph.llm_factory import get_llm
from graph.nodes.llm_node import _make_ai, _make_human, _make_system, _render_template
from graph.state import RetrievalState

logger = logging.getLogger(__name__)

_DEFAULT_PERSONA = """You are a helpful AI assistant. Answer the user's question using the provided context.
Be concise, accurate, and helpful."""

# Appended after the persona (default or request-supplied) so the cycle-exit JSON schema
# contract is preserved regardless of which persona is used.
_JSON_FORMAT_REQUIREMENT = """

You MUST respond with valid JSON in this exact format:
{"answer": "<your answer here>", "needs_more_context": <true|false>}

Set needs_more_context to true ONLY if the provided context is clearly insufficient to answer
the question at all. If you can give a reasonable answer, set it to false."""

_DEFAULT_SYSTEM_PROMPT = _DEFAULT_PERSONA + _JSON_FORMAT_REQUIREMENT

_DEFAULT_INPUT_TEMPLATE = "Context:\n{context}\n\nQuestion: {query}"


def make_reflection_node(node_type: str):
    """
    Platform node for graphs with cycles.

    Like make_llm_node with response_format=json, but with a hard guarantee:
    needs_more_context is ALWAYS written to state (defaulting to False on any
    failure) so a cycle using this node always has a safe exit path.

    Configurable via DDB node config:
      input_template  (str)  — {context}, {query} and other state placeholders
      output_key      (str)  — state field for the answer (default: generated_response)
      include_conversation_history (bool)

    system_prompt and model_override are ignored when output_key is
    "generated_response" (the default) — the persona comes from the request's
    resolved instruction and the model from the request's llm_model.
    """
    async def node(state: RetrievalState) -> dict:
        config = state.get("node_configs", {}).get(node_type, {})
        input_template = config.get("input_template", _DEFAULT_INPUT_TEMPLATE)
        output_key = config.get("output_key", "generated_response")
        include_history: bool = config.get("include_conversation_history", True)

        is_response_node = (output_key == "generated_response")
        if is_response_node:
            # Persona always comes from the request's resolved instruction (node-level
            # system_prompt/model_override are not honored for response generators);
            # the JSON schema requirement is always appended so needs_more_context is
            # emitted regardless of persona (cycle-exit contract).
            request_sp = state.get("request_system_prompt")
            system_prompt = (request_sp or _DEFAULT_PERSONA) + _JSON_FORMAT_REQUIREMENT
            model_override = None
        else:
            system_prompt = config.get("system_prompt", _DEFAULT_SYSTEM_PROMPT)
            model_override = config.get("model_override")

        effective_model = model_override or state.get("llm_model")
        llm = get_llm(
            state["llm_provider"],
            state["llm_credentials"],
            effective_model,
            state.get("llm_max_tokens", 4096),
        )

        provider = state["llm_provider"]
        cache_anthropic = (provider == "anthropic")
        messages: list[Any] = [_make_system(system_prompt, cache_anthropic)]

        rendered_input = _render_template(input_template, state)

        if include_history:
            history = state.get("conversation_history", [])
            turns = history[:-1] if history else []
            
            if not turns:
                messages.append(HumanMessage(content=rendered_input))
            elif is_response_node:
                # For response generation, pass as actual chat turns
                last_idx = len(turns) - 1
                for i, turn in enumerate(turns):
                    role = turn.get("role", "user")
                    content = turn.get("content", "")
                    is_last = (i == last_idx)
                    cache_this = cache_anthropic and is_last
                    if role == "user":
                        messages.append(_make_human(content, cache_this))
                    else:
                        messages.append(_make_ai(content, cache_this))
                messages.append(HumanMessage(content=rendered_input))
            else:
                # For extraction/classification, Anthropic expects context in XML tags
                history_text = "\n".join(f"{t.get('role', 'user').capitalize()}: {t.get('content', '')}" for t in turns)
                combined = f"<conversation_context>\n{history_text}\n</conversation_context>\n\n{rendered_input}"
                messages.append(HumanMessage(content=combined))
        else:
            messages.append(HumanMessage(content=rendered_input))

        logger.info("Node %s (reflection): calling LLM model=%s", node_type, effective_model)
        for idx, m in enumerate(messages):
            logger.info("Node %s - Message %d [%s]:\n%s\n---", node_type, idx, type(m).__name__, m.content)

        response = await llm.ainvoke(messages)
        logger.info("Node %s - Received Response:\n%s\n---", node_type, response.content)

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
