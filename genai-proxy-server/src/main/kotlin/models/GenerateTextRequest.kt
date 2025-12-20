package models

import com.genflowly.aicallerlib.models.AIVendor
import kotlinx.serialization.Serializable

@Serializable
data class GenerateTextRequest(
    val aiConfig: List<AIConfig>,
    val systemPrompt: String,
    val prompt: String,
    val selectedResponseId: String?,
    val conversationId: String?,
    val client: String
)

@Serializable
data class AIConfig(
    val aiVendor: AIVendor,
    val model: String
)