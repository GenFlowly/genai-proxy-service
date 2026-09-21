import asyncio
import json
import logging
import re
import time
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from encoding_library.observability import count, observe
from graph.credentials import credentials_for
from graph.llm_factory import get_llm
from graph.s3_images import fetch_image_base64
from graph.state import RetrievalState
from graph.tools_runtime import get_registry

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


# Travels inside {web_context} so it reaches whichever node renders it — the
# response generator's system prompt is customer-controlled and can't be
# amended per-node. Override or disable via WEB_SEARCH config
# "citation_instruction" ("" disables).
_DEFAULT_CITATION_INSTRUCTION = (
    "When your answer uses information from the sources above, cite them inline "
    "with bracketed numbers matching the source list, e.g. [1] or [2][3]."
)


def _build_web_context(results: list, answer: str | None, citation_instruction: str | None = None) -> str:
    if not results and not answer:
        return "No web search results available."
    parts = []
    if answer:
        parts.append(f"Web search summary: {answer}")
    for i, r in enumerate(results, 1):
        title = r.get("title", "")
        url = r.get("url", "")
        content = r.get("content", "")
        parts.append(f"[{i}] {title} ({url})\n{content}".strip())
    if results:
        instruction = _DEFAULT_CITATION_INSTRUCTION if citation_instruction is None else citation_instruction
        if instruction:
            parts.append(instruction)
    return "\n\n".join(parts)


def _make_system(text: str, cache: bool) -> SystemMessage:
    if cache:
        return SystemMessage(content=[{"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}])
    return SystemMessage(content=text)


def _make_human(content, cache: bool) -> HumanMessage:
    """content is either a plain string or a list of multimodal blocks."""
    if not cache:
        return HumanMessage(content=content)
    if isinstance(content, str):
        return HumanMessage(content=[{"type": "text", "text": content, "cache_control": {"type": "ephemeral"}}])
    # Block list: Anthropic wants cache_control on the last block of the prefix
    blocks = [dict(b) for b in content]
    if blocks:
        blocks[-1] = {**blocks[-1], "cache_control": {"type": "ephemeral"}}
    return HumanMessage(content=blocks)


async def _image_blocks(images: list, strict: bool) -> list:
    """
    Resolve [{s3_key, media_type}, ...] into data-URL image blocks. The
    image_url form is normalized by langchain-anthropic/-openai/-google-genai
    into each provider's native image format, so one shape covers all vendors.

    strict=True (current turn): a fetch failure fails the request.
    strict=False (history replay): failed images degrade to a text note.
    """
    blocks = []
    for img in images or []:
        s3_key = img.get("s3_key", "")
        try:
            b64 = await asyncio.to_thread(fetch_image_base64, s3_key)
            media_type = img.get("media_type") or "image/png"
            blocks.append({"type": "image_url", "image_url": {"url": f"data:{media_type};base64,{b64}"}})
        except Exception as e:
            logger.error("Failed to fetch attachment image %s: %s", s3_key, e)
            if strict:
                raise
            blocks.append({"type": "text", "text": "[attached image unavailable]"})
    return blocks


def _user_content(text: str, image_blocks: list):
    """Plain string when there are no images, otherwise text + image blocks."""
    if not image_blocks:
        return text
    return [{"type": "text", "text": text}, *image_blocks]


# Beta header each Anthropic-native tool version requires. A tool's options may
# carry an explicit "anthropic_beta" to override/extend this mapping.
_NATIVE_TOOL_BETAS = {
    "computer_20250124": "computer-use-2025-01-24",
    "bash_20250124": "computer-use-2025-01-24",
    "computer_20241022": "computer-use-2024-10-22",
    "text_editor_20241022": "computer-use-2024-10-22",
    "bash_20241022": "computer-use-2024-10-22",
}


def _build_tool_specs(tools: list, provider: str) -> tuple[list, list]:
    """
    Convert API tool definitions into bind_tools specs. Returns (specs, betas).

    Function tools (no `type`) become OpenAI function-tool dicts — LangChain
    accepts that one format on all three vendor classes. Native tools (`type`
    set, e.g. computer_20250124) pass through untranslated with their options
    merged in; they are Anthropic-only and may require a beta header.
    """
    specs, betas = [], []
    for t in tools:
        native_type = t.get("type")
        if native_type and native_type != "function":
            if provider != "anthropic":
                raise ValueError(
                    f"Native tool type '{native_type}' is supported on Anthropic (Claude) only"
                )
            spec = {"type": native_type, "name": t["name"], **(t.get("options") or {})}
            beta = spec.pop("anthropic_beta", None) or _NATIVE_TOOL_BETAS.get(native_type)
            if beta and beta not in betas:
                betas.append(beta)
            specs.append(spec)
        else:
            specs.append({
                "type": "function",
                "function": {
                    "name": t["name"],
                    "description": t.get("description", ""),
                    "parameters": t.get("parameters") or {"type": "object", "properties": {}},
                },
            })
    return specs, betas


def _normalize_tool_choice(tool_choice: str | None) -> str | None:
    """Map the API's tool_choice to LangChain's cross-provider vocabulary."""
    if not tool_choice or tool_choice == "auto":
        return "auto" if tool_choice else None
    if tool_choice in ("required", "any"):
        return "any"  # LangChain normalizes "any" per provider ("required" on OpenAI)
    return tool_choice  # a specific tool name


def _history_ai_message(content: str, tool_calls: list, cache: bool) -> AIMessage:
    """Assistant turn that made tool calls — rebuilt so vendors see native tool-use blocks."""
    normalized = [
        {"name": c.get("name", ""), "args": c.get("args") or {}, "id": c.get("id", ""), "type": "tool_call"}
        for c in tool_calls
    ]
    return AIMessage(content=content or "", tool_calls=normalized)


async def _tool_messages(tool_results: list, provider: str) -> list:
    """
    Build ToolMessages, resolving any attached images (e.g. computer-use
    screenshots) into content blocks. Images arrive as base64 data or an S3 key;
    `omitted` entries are historical screenshots stripped at persistence time.
    Image blocks are Anthropic-only — other providers get a text placeholder.
    """
    out = []
    for r in tool_results or []:
        text = r.get("content", "")
        images = r.get("images") or []
        if not images:
            out.append(ToolMessage(content=text, tool_call_id=r.get("tool_call_id", "")))
            continue
        blocks: list = [{"type": "text", "text": text}] if text else []
        for img in images:
            if img.get("omitted"):
                blocks.append({"type": "text", "text": "[screenshot omitted from history]"})
                continue
            if provider != "anthropic":
                blocks.append({"type": "text", "text": "[image tool result omitted — images in tool results are Claude-only]"})
                continue
            media_type = img.get("media_type") or "image/png"
            data = img.get("data")
            if not data and img.get("s3_key"):
                try:
                    data = await asyncio.to_thread(fetch_image_base64, img["s3_key"])
                except Exception as e:
                    logger.error("Failed to fetch tool-result image %s: %s", img.get("s3_key"), e)
                    blocks.append({"type": "text", "text": "[image unavailable]"})
                    continue
            if data:
                blocks.append({"type": "image_url", "image_url": {"url": f"data:{media_type};base64,{data}"}})
        out.append(ToolMessage(content=blocks or "", tool_call_id=r.get("tool_call_id", "")))
    return out


def _content_summary(content) -> str:
    """Log-safe rendering: image blocks become placeholders, never base64."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict) and b.get("type") == "image_url":
                parts.append("<image>")
            elif isinstance(b, dict):
                parts.append(str(b.get("text", b)))
            else:
                parts.append(str(b))
        return " ".join(parts)
    return str(content)


def _make_ai(text: str, cache: bool) -> AIMessage:
    if cache:
        return AIMessage(content=[{"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}])
    return AIMessage(content=text)


# State fields nodes may write into directly; any other output_key routes into
# the free-form `scratch` channel, readable from later templates/conditions.
_DIRECT_OUTPUT_KEYS = {
    "generated_response",
    "rewritten_query",
    "ranked_results",
    "retrieval_results",
    "query_intent",
    "needs_rewrite",
    "needs_more_context",
    "web_search_results",
    "web_search_answer",
    "error",
    "tool_calls",
}


# Prompt/response excerpts surfaced in the client's thinking panel.
_TRACE_TEXT_LIMIT = 1500


def _trace_entry(node_label: str, prompt: str, response) -> dict:
    text = response if isinstance(response, str) else json.dumps(response, default=str)
    return {"trace": [{
        "node": node_label,
        "prompt": (prompt or "")[:_TRACE_TEXT_LIMIT],
        "response": (text or "")[:_TRACE_TEXT_LIMIT],
    }]}


def _route_output(key, value) -> dict:
    """State-update dict for one output: first-class field or scratch entry."""
    if key in _DIRECT_OUTPUT_KEYS:
        return {key: value}
    return {"scratch": {key: value}}


def _merge_outputs(updates: list[dict]) -> dict:
    """Merge routed outputs, combining their scratch sub-dicts."""
    merged: dict = {}
    scratch: dict = {}
    for update in updates:
        scratch.update(update.pop("scratch", {}) or {})
        merged.update(update)
    if scratch:
        merged["scratch"] = scratch
    return merged


# Optional template sections: {?field}...{/field} renders its body only when
# `field` has a real value (non-empty retrieval results for {?context}, web
# results for {?web_context}, a non-blank string / non-empty list otherwise).
_SECTION_RE = re.compile(r"\{\?(\w+)\}(.*?)\{/\1\}", re.DOTALL)


def _render_template(template: str, state: dict) -> str:
    """
    Replace {field_name} placeholders with values from state, scratch or
    computed variables. {?field}...{/field} blocks are optional sections,
    dropped entirely when the field has no real value — e.g.
    "{?context}Context:\n{context}\n\n{/context}Question: {query}" skips the
    whole Context section when retrieval found nothing.
    """
    ranked = state.get("ranked_results") or state.get("retrieval_results", [])
    web_results = state.get("web_search_results", [])
    web_answer = state.get("web_search_answer")
    computed = {
        "context": _build_context(ranked),
        "query": state.get("rewritten_query") or state.get("original_query", ""),
        "chunks_text": _build_chunks_text(state.get("retrieval_results", [])),
        "web_context": _build_web_context(
            web_results,
            web_answer,
            state.get("node_configs", {}).get("WEB_SEARCH", {}).get("citation_instruction"),
        ),
    }
    scalars = lambda d: {k: v for k, v in d.items() if isinstance(v, (str, int, float, bool))}  # noqa: E731
    scratch = state.get("scratch", {}) or {}
    all_vars = {**scalars(scratch), **scalars(state), **computed}

    # Presence of a field for {?field} sections: the computed vars render
    # placeholder text even when empty, so test the underlying data instead.
    def has_value(name: str) -> bool:
        if name == "context":
            return bool(ranked)
        if name == "web_context":
            return bool(web_results or web_answer)
        if name == "chunks_text":
            return bool(state.get("retrieval_results"))
        val = scratch.get(name, state.get(name))
        if val is None:
            return name in all_vars and bool(str(all_vars[name]).strip())
        if isinstance(val, str):
            return bool(val.strip())
        if isinstance(val, (list, dict)):
            return bool(val)
        return bool(val)

    template = _SECTION_RE.sub(
        lambda m: m.group(2) if has_value(m.group(1)) else "", template
    )

    def replace(match):
        val = all_vars.get(match.group(1), "")
        return str(val) if val is not None else ""

    return re.sub(r"\{(\w+)\}", replace, template)


def make_llm_node(agent_type: str, node_id: str | None = None):
    """
    Returns an async LangGraph node function driven entirely by DDB config.

    Config keys (all optional — sane defaults apply):
      system_prompt                (str)  — SystemMessage content
      input_template               (str)  — HumanMessage with {state_field} placeholders.
                                            Special vars: {query}, {context}, {chunks_text}, {web_context}
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
        # Config keyed by node identity first — the same node type can appear
        # multiple times with different configs — then by type (fallback and
        # statically-built graphs).
        configs = state.get("node_configs", {})
        config = (configs.get(node_id) if node_id else None) or configs.get(agent_type, {})

        input_template = config.get("input_template", "{original_query}")
        output_key = config.get("output_key")
        is_response_node = (output_key == "generated_response")

        # Response generators always take their persona from the request's resolved
        # instruction and their model from the request's aiConfig — node-level
        # system_prompt/model_override are not honored for them.
        if is_response_node:
            system_prompt = state.get("request_system_prompt") or "You are a helpful assistant."
            # Learned user memories (MEMORY node) ride on the persona.
            memories_block = state.get("memories_block")
            if memories_block:
                system_prompt = f"{system_prompt}\n\n{memories_block}"
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
                return {**_route_output(output_key, []), "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}}

        effective_model = model_override or state.get("llm_model")

        # Structured output: a caller-supplied JSON Schema the response must
        # conform to. Only the response generator honors it. Enforced through
        # LangChain's with_structured_output, which maps to each vendor's
        # native mechanism (OpenAI json_schema/function calling, Anthropic
        # forced tool use, Gemini function calling) — the model cannot emit
        # free-form prose. Mutually exclusive with tools (validated upstream).
        response_schema = state.get("response_schema") if is_response_node and response_format == "text" else None

        # Caller-defined tools bind only to the plain-text response generator;
        # JSON-format nodes and pipeline nodes never see them. Native Anthropic
        # tools (computer use etc.) may require beta headers, which must be set
        # when the client is created — so specs are built before get_llm.
        # Built-in tools (graph_tools registry, enabled via the graph's
        # TOOL_EXECUTOR node) bind alongside them — their calls are executed
        # in-graph by the TOOL_EXECUTOR node instead of exiting to the caller.
        tools = state.get("tools") or []
        builtin_names = state.get("builtin_tools") or []
        if is_response_node and builtin_names:
            builtin_specs = get_registry().specs(builtin_names)
            # A caller-defined tool shadowing a built-in name would make its
            # calls ambiguous (executed in-graph vs. by the caller) — built-in wins.
            reserved = {s["name"] for s in builtin_specs}
            shadowed = [t.get("name") for t in tools if t.get("name") in reserved]
            if shadowed:
                logger.warning("Node %s: caller tool(s) %s shadow built-in tools — dropped", agent_type, shadowed)
            tools = [t for t in tools if t.get("name") not in reserved] + builtin_specs
        tools_bound = bool(is_response_node and tools and response_format == "text" and not response_schema)
        tool_specs: list = []
        llm_betas: list = []
        if tools_bound:
            tool_specs, llm_betas = _build_tool_specs(tools, state["llm_provider"])

        llm = get_llm(
            state["llm_provider"],
            credentials_for(state),
            effective_model,
            state.get("llm_max_tokens", 4096),
            betas=llm_betas or None,
        )

        if tools_bound:
            tool_choice = _normalize_tool_choice(state.get("tool_choice"))
            bind_kwargs = {"tool_choice": tool_choice} if tool_choice else {}
            llm = llm.bind_tools(tool_specs, **bind_kwargs)

        # include_raw keeps the AIMessage (and its usage_metadata) alongside the
        # parsed object. Anthropic gets method="json_schema" — Claude's native
        # structured-outputs API (grammar-constrained decoding), which takes the
        # raw JSON Schema and needs a top-level title as the schema name; the
        # default forced-tool-call method only steers toward the schema. OpenAI
        # and Gemini default to their own native json_schema methods and accept
        # the OpenAI function-format spec.
        structured_llm = None
        if response_schema:
            if state["llm_provider"] == "anthropic":
                structured_llm = llm.with_structured_output(
                    {"title": "structured_response", **response_schema},
                    method="json_schema",
                    include_raw=True,
                )
            else:
                structured_llm = llm.with_structured_output(
                    {
                        "name": "structured_response",
                        "description": response_schema.get(
                            "description", "Respond with a single object in this exact JSON structure."
                        ),
                        "parameters": response_schema,
                    },
                    include_raw=True,
                )

        provider = state["llm_provider"]
        request_source = state.get("request_source") or "conversation"
        # Cache stable prefixes (system prompt + conversation history) on the response
        # generator. Anthropic requires explicit cache_control blocks; OpenAI caches
        # automatically for prefixes >=1024 tokens.
        cache_anthropic = (provider == "anthropic")

        messages: list[Any] = [_make_system(system_prompt, cache_anthropic)]

        rendered_input = _render_template(input_template, state)

        # Only the response generator sees images — retrieval/ranking/classification
        # nodes stay text-only (they don't need pixels, and it keeps them cheap).
        query_image_blocks: list = []
        if is_response_node:
            query_image_blocks = await _image_blocks(state.get("query_images", []), strict=True)
        current_content = _user_content(rendered_input, query_image_blocks)

        # Tool results for the current turn — must directly follow the assistant
        # message whose tool_calls they answer (the last history turn).
        current_tool_messages = (
            await _tool_messages(state.get("query_tool_results"), provider) if is_response_node else []
        )
        # A tool-continuation request may carry no new prompt text; don't send an
        # empty user message in that case.
        has_current_text = bool(rendered_input.strip()) or bool(query_image_blocks)

        def _append_current_turn():
            messages.extend(current_tool_messages)
            if has_current_text or not current_tool_messages:
                messages.append(HumanMessage(content=current_content))

        if include_history:
            history = state.get("conversation_history", [])
            turns = history[:-1] if history else []

            if not turns:
                _append_current_turn()
            elif is_response_node:
                # For response generation, pass as actual chat turns
                last_idx = len(turns) - 1
                for i, turn in enumerate(turns):
                    role = turn.get("role", "user")
                    content = turn.get("content", "")
                    is_last = (i == last_idx)
                    cache_this = cache_anthropic and is_last
                    if role == "user":
                        # Replayed tool results precede the turn's own text
                        messages.extend(await _tool_messages(turn.get("tool_results"), provider))
                        turn_blocks = await _image_blocks(turn.get("images", []), strict=False)
                        if content or turn_blocks:
                            messages.append(_make_human(_user_content(content, turn_blocks), cache_this))
                    else:
                        turn_tool_calls = turn.get("tool_calls") or []
                        if turn_tool_calls:
                            messages.append(_history_ai_message(content, turn_tool_calls, cache_this))
                        else:
                            messages.append(_make_ai(content, cache_this))
                _append_current_turn()
            else:
                # For extraction/classification, Anthropic expects context in XML tags
                history_text = "\n".join(f"{t.get('role', 'user').capitalize()}: {t.get('content', '')}" for t in turns)
                combined = f"<conversation_context>\n{history_text}\n</conversation_context>\n\n{rendered_input}"
                messages.append(HumanMessage(content=combined))
        else:
            _append_current_turn()

        # In-graph agent loop (TOOL_EXECUTOR): replay this request's built-in
        # tool exchanges after the current user turn, so on re-entry the model
        # sees its own tool calls answered and produces the final response.
        if is_response_node:
            for lm in state.get("loop_messages") or []:
                if lm.get("role") == "assistant":
                    messages.append(
                        _history_ai_message(lm.get("content", ""), lm.get("tool_calls") or [], False)
                    )
                else:
                    messages.append(
                        ToolMessage(content=lm.get("content", ""), tool_call_id=lm.get("tool_call_id", ""))
                    )

        logger.info(
            "Node %s: calling LLM, format=%s model=%s caching=%s query_images=%d",
            agent_type, response_format, effective_model, cache_anthropic, len(query_image_blocks),
        )
        for idx, m in enumerate(messages):
            logger.info("Node %s - Message %d [%s]:\n%s\n---", agent_type, idx, type(m).__name__, _content_summary(m.content))

        parsed = None
        parsing_error = None
        llm_start = time.perf_counter()
        try:
            if structured_llm is not None:
                wrapped = await structured_llm.ainvoke(messages)
                response = wrapped["raw"]
                parsed = wrapped["parsed"]
                parsing_error = wrapped["parsing_error"]
                logger.info("Node %s - Received structured response: parsed=%s error=%s", agent_type, parsed is not None, parsing_error)
            else:
                response = await llm.ainvoke(messages)
                logger.info("Node %s - Received Response:\n%s\n---", agent_type, response.content)
        except Exception:
            count("llm_request_total", status="error", vendor=provider, model=effective_model,
                  source=request_source, operation=agent_type.lower())
            raise
        count("llm_request_total", status="ok", vendor=provider, model=effective_model,
              source=request_source, operation=agent_type.lower())
        observe("llm_request_duration_seconds", time.perf_counter() - llm_start, vendor=provider)

        meta = getattr(response, "usage_metadata", None) or {}
        details = meta.get("input_token_details") or {}
        usage = {
            "input_tokens": meta.get("input_tokens", 0),
            "output_tokens": meta.get("output_tokens", 0),
            "total_tokens": meta.get("total_tokens", 0),
            "cache_read_tokens": details.get("cache_read", 0),
            "cache_creation_tokens": details.get("cache_creation", 0),
        }
        # vendor+model token totals back the cost dashboards until exact
        # costUsd is emitted from the Kotlin proxy (Micrometer pass).
        if usage["input_tokens"]:
            count("llm_tokens_total", usage["input_tokens"], vendor=provider, model=effective_model, direction="input")
        if usage["output_tokens"]:
            count("llm_tokens_total", usage["output_tokens"], vendor=provider, model=effective_model, direction="output")
        if usage["cache_read_tokens"]:
            count("llm_tokens_total", usage["cache_read_tokens"], vendor=provider, model=effective_model, direction="cache_read")
        if usage["cache_creation_tokens"]:
            count("llm_tokens_total", usage["cache_creation_tokens"], vendor=provider, model=effective_model, direction="cache_creation")
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
                result = _merge_outputs([
                    _route_output(state_key, parsed.get(llm_key))
                    for llm_key, state_key in json_output_mapping.items()
                ])
                result["usage"] = usage
                result.update(_trace_entry(agent_type, rendered_input, content))
                return result
            except json.JSONDecodeError:
                logger.error("Node %s: expected JSON, got: %s", agent_type, _get_text(response.content)[:200])
                return {"usage": usage, **_trace_entry(agent_type, rendered_input, _get_text(response.content))}

        if response_format == "json_indices":
            source = state.get(json_indices_source_key, [])
            try:
                content = _get_text(response.content).strip()
                if content.startswith("```"):
                    content = re.sub(r"^```[a-z]*\n?", "", content)
                    content = re.sub(r"\n?```$", "", content).strip()
                indices = json.loads(content)
                reordered = [source[i] for i in indices if i < len(source)]
                return {**_route_output(output_key, reordered), "usage": usage,
                        **_trace_entry(agent_type, rendered_input, content)}
            except (json.JSONDecodeError, TypeError, ValueError):
                logger.error("Node %s: expected index array, got: %s — using original order", agent_type, _get_text(response.content)[:200])
                return {**_route_output(output_key, source), "usage": usage,
                        **_trace_entry(agent_type, rendered_input, _get_text(response.content))}

        if structured_llm is not None:
            if parsed is not None:
                return {**_route_output(output_key, json.dumps(parsed)), "usage": usage,
                        **_trace_entry(agent_type, rendered_input, json.dumps(parsed))}
            # Constrained decoding makes this near-unreachable; degrade to the
            # raw text so the caller's own parse (and failover) can decide.
            logger.error(
                "Node %s: structured output parse failed (%s) — returning raw text",
                agent_type, parsing_error,
            )
            return {**_route_output(output_key, _get_text(response.content)), "usage": usage,
                    **_trace_entry(agent_type, rendered_input, _get_text(response.content))}

        # response_format == "text"
        result = {**_route_output(output_key, _get_text(response.content)), "usage": usage,
                  **_trace_entry(agent_type, rendered_input, _get_text(response.content))}
        if tools_bound:
            raw_tool_calls = getattr(response, "tool_calls", None) or []
            if raw_tool_calls:
                result["tool_calls"] = [
                    {"id": c.get("id", ""), "name": c.get("name", ""), "args": c.get("args") or {}}
                    for c in raw_tool_calls
                ]
                logger.info(
                    "Node %s: model requested %d tool call(s): %s",
                    agent_type, len(raw_tool_calls), [c.get("name") for c in raw_tool_calls],
                )
        return result

    node.__name__ = f"llm_node_{agent_type.lower()}"
    return node
