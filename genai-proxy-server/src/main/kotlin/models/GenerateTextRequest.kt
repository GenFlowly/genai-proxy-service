package models

import com.genflowly.aicallerlib.models.AIVendor
import kotlinx.serialization.Serializable

@Serializable
data class GenerateTextRequest(
    val aiConfig: List<AIConfig>,
    val prompt: Prompt,
    val selectedResponseId: String?,
    val conversationId: String?,
    val client: String,
    // false → direct LLM generation: skip the agent graph (no retrieval/RAG)
    val agentic: Boolean = true
)

@Serializable
data class AIConfig(
    val aiVendor: AIVendor,
    val model: String,
    val maxTokens: Int? = null
)


@Serializable
data class Prompt(
    val instructionId: String,
    val instructionVersion: String,
    val prompt: String,
)