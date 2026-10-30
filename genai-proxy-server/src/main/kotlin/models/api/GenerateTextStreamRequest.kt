package com.genflowly.models.api

import kotlinx.serialization.Serializable
import com.genflowly.models.AIConfig
import com.genflowly.models.Prompt

@Serializable
data class GenerateTextStreamRequest(
    val aiConfig: AIConfig,
    val prompt: Prompt,
    val selectedResponseId: String?,
    val conversationId: String?,
    val client: String,
    // false → direct LLM generation: skip the agent graph (no retrieval/RAG)
    val agentic: Boolean = true,
    /** Caller-defined tools the model may call; works across all vendors */
    val tools: List<com.genflowly.models.ToolDefinition> = emptyList(),
    /** "auto" (default), "required", or a specific tool name */
    val toolChoice: String? = null,
    /** Results for the previous assistant message's tool calls — continues the turn */
    val toolResults: List<com.genflowly.models.ToolResult> = emptyList(),
    /**
     * JSON Schema (type=object) the response must conform to. Enforced through
     * the vendor's native structured-output mechanism. Because the JSON is only
     * valid once complete, the stream emits it as a single content chunk when
     * generation finishes (after any thinking events) rather than token by
     * token. Mutually exclusive with [tools]. Works across all vendors.
     */
    val responseSchema: kotlinx.serialization.json.JsonObject? = null,

    /** Consent: learn new memories about the user from this conversation. */
    val learnFromConversation: Boolean = true,
    /** Consent: apply already-learned memories/preferences to this response. */
    val useLearnedPreferences: Boolean = true,

    /**
     * Agent (graph) to run this generation through: a graphId owned by the
     * customer or published by System. null (default) keeps the server-side
     * resolution: the customer's default agent, falling back to the System one.
     */
    val agentId: String? = null,

    /**
     * Project a brand-new conversation is created into (history-sidebar
     * grouping). Only read when [conversationId] is absent; a projectId that
     * doesn't exist for the caller is dropped with a warning rather than
     * failing the generation.
     */
    val projectId: String? = null,

    /**
     * Set by the Regenerate button: the user message id of the turn being
     * regenerated. Lets the backend reuse that exact message as the parent
     * instead of creating a new one — the "latest message is still role=user"
     * heuristic (findActiveTurnUserMessage) only holds for racing parallel
     * vendor calls of the original send, never for a later Regenerate click,
     * since by then the first AI reply is already persisted.
     */
    val regenerateMessageId: String? = null,
)
