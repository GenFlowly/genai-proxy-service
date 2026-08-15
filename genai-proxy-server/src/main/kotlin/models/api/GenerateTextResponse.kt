package models

import kotlinx.serialization.Serializable

@Serializable
data class GenerateTextResponse(
    val text: String?,
    val aiVendor: String?,
    val conversationId: String?,
    val messageId: String?,
    val inputTokens: Int? = null,
    val outputTokens: Int? = null,
    val totalTokens: Int? = null,
    val tokensReadFromCache: Int? = null,
    /** Retrieval-server thinking time (request receipt → first generated token), ms */
    val thinkingDurationMs: Long? = null
)