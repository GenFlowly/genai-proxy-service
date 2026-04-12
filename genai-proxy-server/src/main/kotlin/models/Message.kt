package models

import com.genflowly.aicallerlib.models.AIVendor
import java.util.UUID

data class Message(
    val messageId: String = UUID.randomUUID().toString(),
    val conversationId: String,
    val text: String,
    val client: String,
    val role: String,
    val customerId: String,
    var sequence: Int? = 0,
    val systemPrompt: String,
    val aiConfig: List<AIConfig>,
    val previousMessageId: String?,
    val instructionId: String? = null,
    val instructionVersion: String? = null,
    val inputTokens: Int? = null,
    val outputTokens: Int? = null,
    val totalTokens: Int? = null,
    val tokensReadFromCache: Int? = null
)