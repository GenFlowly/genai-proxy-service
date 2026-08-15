"""Expose the customer's LangGraph graph as a callable tool for voice sessions.

The voice model (OpenAI Realtime / Gemini Live) handles the audio conversation;
whenever it needs grounded knowledge it calls `search_knowledge_base`, which runs
the customer's configured retrieval graph and returns the generated answer text.
"""
import logging

logger = logging.getLogger(__name__)

KNOWLEDGE_TOOL = {
    "name": "search_knowledge_base",
    "description": (
        "Search the user's knowledge base (notes, documents, saved data) and answer "
        "questions grounded in it. Use this for any question that may relate to the "
        "user's stored information."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "The user's question, rephrased as a standalone search query.",
            }
        },
        "required": ["query"],
    },
}


def make_graph_tool_executor(init: dict):
    """Build an async tool executor bound to one voice session's context.

    `init` is the session.init payload. The graph's LLM defaults to the voice
    session's provider/credentials; `graph_provider` / `graph_model` override it.
    """

    async def execute(name: str, args: dict) -> str:
        if name != KNOWLEDGE_TOOL["name"]:
            return f"Unknown tool: {name}"

        query = (args or {}).get("query", "")
        if not query:
            return "No query provided."

        # Imported lazily to avoid importing route modules at package import time
        from models import ConversationMessage, RawData, RetrieveRequest
        from routes.retrieve import _build_state, _direct_graph, _resolve_graph

        history = [
            ConversationMessage(role=t.get("role", "user"), content=t.get("content", ""))
            for t in (init.get("conversation_history") or [])
            if t.get("content")
        ]

        req = RetrieveRequest(
            customer_id=init["customer_id"],
            client=init.get("client", "voice"),
            data_type="text",
            raw_data=RawData(query_data=query),
            llm_credentials=init.get("llm_credentials") or {},
            llm_provider=init.get("graph_provider") or init.get("provider", "openai"),
            llm_model=init.get("graph_model"),
            llm_max_tokens=init.get("llm_max_tokens", 4096),
            conversation_history=history,
            system_prompt=init.get("system_prompt"),
            agentic=init.get("agentic", True),
        )

        try:
            if req.agentic:
                graph, _, node_configs, _, max_iterations = _resolve_graph(req.customer_id)
            else:
                graph, _, node_configs, _, max_iterations = _direct_graph()

            state = _build_state(req, node_configs)
            result = await graph.ainvoke(state, config={"recursion_limit": max_iterations})

            if result.get("error"):
                logger.warning("Voice graph tool error for customer=%s: %s", req.customer_id, result["error"])
                return f"The knowledge base lookup failed: {result['error']}"

            response = result.get("generated_response") or ""
            logger.info(
                "Voice graph tool completed for customer=%s query_len=%d response_len=%d",
                req.customer_id, len(query), len(response),
            )
            return response or "No relevant information found."
        except Exception as e:
            logger.error("Voice graph tool invocation failed: %s", e, exc_info=True)
            return f"The knowledge base lookup failed: {e}"

    return execute
