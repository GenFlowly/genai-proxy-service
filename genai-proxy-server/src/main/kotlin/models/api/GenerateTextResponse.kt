package models

import kotlinx.serialization.Serializable

@Serializable
data class GenerateTextResponse(
    val text: String?,
    val aiVendor: String?,
    val conversationId: String?,
    val messageId: String?,
    val inputTokens: Int? = null,
    val outputTokens: Int? = null
)