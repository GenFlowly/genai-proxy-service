import json
import logging
import re
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from graph.llm_factory import get_llm
from graph.state import RetrievalState

logger = logging.getLogger(__name__)


def _build_context(results: list) -> str:
    if not results:
        return "No relevant context found."
    parts = []
    for i, r in enumerate(results, 1):
        entity = r.get("entity", {})
        title = entity.get("title") or entity.get("subject", "")
        note = entity.get("note_value", "")
        parts.append(f"[{i}] {title}\n{note}".strip())
    return "\n\n".join(parts)


def _build_chunks_text(results: list) -> str:
    return "\n".join(
        f"[{i}] {r['entity'].get('note_value') or r['entity'].get('title', '')}"
        for i, r in enumerate(results)
    )


def _make_system(text: str, cache: bool) -> SystemMessage:
    if cache:
        return SystemMessage(content=[{"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}])
    return SystemMessage(content=text)


def _make_human(text: str, cache: bool) -> HumanMessage:
    if cache:
        return HumanMessage(content=[{"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}])
    return HumanMessage(content=text)


def _make_ai(text: str, cache: bool) -> AIMessage:
    if cache:
        return AIMessage(content=[{"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}])
    return AIMessage(content=text)


def _render_template(template: str, state: dict) -> str:
    """Replace {field_name} placeholders with values from state or computed variables."""
    ranked = state.get("ranked_results") or state.get("retrieval_results", [])
    computed = {
        "context": _build_context(ranked),
        "query": state.get("rewritten_query") or state.get("original_query", ""),
        "chunks_text": _build_chunks_text(state.get("retrieval_results", [])),
    }
    all_vars = {**{k: v for k, v in state.items() if isinstance(v, (str, int, float, bool))}, **computed}

    def replace(match):
        val = all_vars.get(match.group(1), "")
        return str(val) if val is not None else ""

    return re.sub(r"\{(\w+)\}", replace, template)


def make_llm_node(agent_type: str):
    """
    Returns an async LangGraph node function driven entirely by DDB config.

    Config keys (all optional — sane defaults apply):
      system_prompt                (str)  — SystemMessage content
      input_template               (str)  — HumanMessage with {state_field} placeholders.
                                            Special vars: {query}, {context}, {chunks_text}
      output_key                   (str)  — state field to write the response into
      response_format              (str)  — "text" | "json" | "json_indices"
      json_output_mapping          (dict) — {"llm_key": "state_key"} for response_format=json
      json_indices_source_key      (str)  — state list to reorder for response_format=json_indices
      include_conversation_history (bool) — prepend prior turns before the user message
      model_override               (str)  — override the request-level llm_model

    Note: system_prompt and model_override are ignored when output_key is
    "generated_response" — response generators always use the request's resolved
    instruction as system prompt and the request's llm_model.
    """
    async def node(state: RetrievalState) -> dict:
        config = state.get("node_configs", {}).get(agent_type, {})

        input_template = config.get("input_template", "{original_query}")
        output_key = config.get("output_key")
        is_response_node = (output_key == "generated_response")

        # Response generators always take their persona from the request's resolved
        # instruction and their model from the request's aiConfig — node-level
        # system_prompt/model_override are not honored for them.
        if is_response_node:
            system_prompt = state.get("request_system_prompt") or "You are a helpful assistant."
            model_override = None
        else:
            system_prompt = config.get("system_prompt", "You are a helpful assistant.")
            model_override = config.get("model_override")
        response_format = config.get("response_format", "text")
        json_output_mapping: dict = config.get("json_output_mapping", {})
        json_indices_source_key: str = config.get("json_indices_source_key", "retrieval_results")
        include_history: bool = config.get("include_conversation_history", True)

        # Short-circuit: skip LLM call if source list for json_indices is empty
        if response_format == "json_indices":
            source = state.get(json_indices_source_key, [])
            if not source:
                logger.info("Node %s: source list is empty — skipping LLM call", agent_type)
                return {output_key: [], "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}}

        effective_model = model_override or state.get("llm_model")
        llm = get_llm(
            state["llm_provider"],
            state["llm_credentials"],
            effective_model,
            state.get("llm_max_tokens", 4096),
        )

        provider = state["llm_provider"]
        # Cache stable prefixes (system prompt + conversation history) on the response
        # generator. Anthropic requires explicit cache_control blocks; OpenAI caches
        # automatically for prefixes >=1024 tokens.
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

        logger.info("Node %s: calling LLM, format=%s model=%s caching=%s", agent_type, response_format, effective_model, cache_anthropic)
        for idx, m in enumerate(messages):
            logger.info("Node %s - Message %d [%s]:\n%s\n---", agent_type, idx, type(m).__name__, m.content)

        response = await llm.ainvoke(messages)
        logger.info("Node %s - Received Response:\n%s\n---", agent_type, response.content)

        meta = getattr(response, "usage_metadata", None) or {}
        details = meta.get("input_token_details") or {}
        usage = {
            "input_tokens": meta.get("input_tokens", 0),
            "output_tokens": meta.get("output_tokens", 0),
            "total_tokens": meta.get("total_tokens", 0),
            "cache_read_tokens": details.get("cache_read", 0),
            "cache_creation_tokens": details.get("cache_creation", 0),
        }
        if usage["cache_read_tokens"] or usage["cache_creation_tokens"]:
            logger.info(
                "Node %s: cache stats — read=%d creation=%d (provider=%s)",
                agent_type, usage["cache_read_tokens"], usage["cache_creation_tokens"], provider,
            )

        def _get_text(content) -> str:
            if isinstance(content, str):
                return content
            elif isinstance(content, list):
                return "".join(b.get("text", "") if isinstance(b, dict) else str(b) for b in content)
            return str(content)

        if response_format == "json":
            try:
                content = _get_text(response.content).strip()
                if content.startswith("```"):
                    content = re.sub(r"^```[a-z]*\n?", "", content)
                    content = re.sub(r"\n?```$", "", content).strip()
                parsed = json.loads(content)
                result = {state_key: parsed.get(llm_key) for llm_key, state_key in json_output_mapping.items()}
                result["usage"] = usage
                return result
            except json.JSONDecodeError:
                logger.error("Node %s: expected JSON, got: %s", agent_type, _get_text(response.content)[:200])
                return {"usage": usage}

        if response_format == "json_indices":
            source = state.get(json_indices_source_key, [])
            try:
                content = _get_text(response.content).strip()
                if content.startswith("```"):
                    content = re.sub(r"^```[a-z]*\n?", "", content)
                    content = re.sub(r"\n?```$", "", content).strip()
                indices = json.loads(content)
                reordered = [source[i] for i in indices if i < len(source)]
                return {output_key: reordered, "usage": usage}
            except (json.JSONDecodeError, TypeError, ValueError):
                logger.error("Node %s: expected index array, got: %s — using original order", agent_type, _get_text(response.content)[:200])
                return {output_key: source, "usage": usage}

        # response_format == "text"
        return {output_key: _get_text(response.content), "usage": usage}

    node.__name__ = f"llm_node_{agent_type.lower()}"
    return node
