package com.genflowly.models.api

import kotlinx.serialization.Serializable
import models.AIConfig
import models.Prompt

@Serializable
data class GenerateTextStreamRequest(
    val aiConfig: AIConfig,
    val prompt: Prompt,
    val selectedResponseId: String?,
    val conversationId: String?,
    val client: String,
    // false → direct LLM generation: skip the agent graph (no retrieval/RAG)
    val agentic: Boolean = true
)
