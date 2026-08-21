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
    val toolResults: List<com.genflowly.models.ToolResult> = emptyList()
)
