import json
import logging
import time
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from encoding_library.observability import count, observe
from graph.credentials import credentials_for
from graph.llm_factory import get_llm
from graph.nodes.llm_node import (
    _content_summary,
    _dbos_active,
    _durable_llm_invoke,
    _trace_entry,
    _image_blocks,
    _make_ai,
    _make_human,
    _make_system,
    _render_template,
    _user_content,
)
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


def make_reflection_node(node_type: str, node_id: str | None = None):
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
        configs = state.get("node_configs", {})
        config = (configs.get(node_id) if node_id else None) or configs.get(node_type, {})
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
            persona = request_sp or _DEFAULT_PERSONA
            # Learned user memories (MEMORY node) ride on the persona.
            memories_block = state.get("memories_block")
            if memories_block:
                persona = f"{persona}\n\n{memories_block}"
            system_prompt = persona + _JSON_FORMAT_REQUIREMENT
            model_override = None
        else:
            system_prompt = config.get("system_prompt", _DEFAULT_SYSTEM_PROMPT)
            model_override = config.get("model_override")

        effective_model = model_override or state.get("llm_model")
        # Durable /runs path invokes the LLM as a memoized DBOS step (exactly-once);
        # /retrieve builds + invokes inline. See llm_node for the rationale.
        use_durable = _dbos_active()
        llm = None
        if not use_durable:
            llm = get_llm(
                state["llm_provider"],
                credentials_for(state),
                effective_model,
                state.get("llm_max_tokens", 4096),
            )

        provider = state["llm_provider"]
        request_source = state.get("request_source") or "conversation"
        cache_anthropic = (provider == "anthropic")
        messages: list[Any] = [_make_system(system_prompt, cache_anthropic)]

        rendered_input = _render_template(input_template, state)

        # Response generators send the current turn's images; other nodes stay text-only
        query_image_blocks: list = []
        if is_response_node:
            query_image_blocks = await _image_blocks(state.get("query_images", []), strict=True)
        current_content = _user_content(rendered_input, query_image_blocks)

        if include_history:
            history = state.get("conversation_history", [])
            turns = history[:-1] if history else []

            if not turns:
                messages.append(HumanMessage(content=current_content))
            elif is_response_node:
                # For response generation, pass as actual chat turns
                last_idx = len(turns) - 1
                for i, turn in enumerate(turns):
                    role = turn.get("role", "user")
                    content = turn.get("content", "")
                    is_last = (i == last_idx)
                    cache_this = cache_anthropic and is_last
                    if role == "user":
                        turn_blocks = await _image_blocks(turn.get("images", []), strict=False)
                        messages.append(_make_human(_user_content(content, turn_blocks), cache_this))
                    else:
                        messages.append(_make_ai(content, cache_this))
                messages.append(HumanMessage(content=current_content))
            else:
                # For extraction/classification, Anthropic expects context in XML tags
                history_text = "\n".join(f"{t.get('role', 'user').capitalize()}: {t.get('content', '')}" for t in turns)
                combined = f"<conversation_context>\n{history_text}\n</conversation_context>\n\n{rendered_input}"
                messages.append(HumanMessage(content=combined))
        else:
            messages.append(HumanMessage(content=current_content))

        logger.info("Node %s (reflection): calling LLM model=%s", node_type, effective_model)
        for idx, m in enumerate(messages):
            logger.info("Node %s - Message %d [%s]:\n%s\n---", node_type, idx, type(m).__name__, _content_summary(m.content))

        llm_start = time.perf_counter()
        try:
            if use_durable:
                out = await _durable_llm_invoke(
                    state["llm_provider"], state["customer_id"], effective_model,
                    state.get("llm_max_tokens", 4096), [], False, [], None, None, messages,
                )
                response = out["response"]
            else:
                response = await llm.ainvoke(messages)
        except Exception:
            count("llm_request_total", status="error", vendor=provider, model=effective_model,
                  source=request_source, operation=node_type.lower())
            raise
        count("llm_request_total", status="ok", vendor=provider, model=effective_model,
              source=request_source, operation=node_type.lower())
        observe("llm_request_duration_seconds", time.perf_counter() - llm_start, vendor=provider)
        logger.info("Node %s - Received Response:\n%s\n---", node_type, response.content)

        meta = getattr(response, "usage_metadata", None) or {}
        usage = {
            "input_tokens": meta.get("input_tokens", 0),
            "output_tokens": meta.get("output_tokens", 0),
            "total_tokens": meta.get("total_tokens", 0),
            "reasoning_tokens": (meta.get("output_token_details") or {}).get("reasoning", 0),
        }
        if usage["input_tokens"]:
            count("llm_tokens_total", usage["input_tokens"], vendor=provider, model=effective_model, direction="input")
        if usage["output_tokens"]:
            count("llm_tokens_total", usage["output_tokens"], vendor=provider, model=effective_model, direction="output")

        try:
            parsed = json.loads(response.content)
            needs_more = bool(parsed.get("needs_more_context", False))
            logger.info("Node %s: needs_more_context=%s", node_type, needs_more)
            return {
                output_key: parsed.get("answer", ""),
                "needs_more_context": needs_more,
                "usage": usage,
                **_trace_entry(node_type, rendered_input, parsed.get("answer", "")),
            }
        except (json.JSONDecodeError, Exception) as e:
            # Always exit the cycle safely on parse failure — never leave
            # needs_more_context unset or True from a previous iteration.
            logger.error("Node %s: JSON parse failed (%s) — exiting cycle safely", node_type, e)
            return {
                output_key: response.content,
                "needs_more_context": False,
                "usage": usage,
                **_trace_entry(node_type, rendered_input, str(response.content)),
            }

    node.__name__ = f"reflection_node_{node_type.lower()}"
    return node
