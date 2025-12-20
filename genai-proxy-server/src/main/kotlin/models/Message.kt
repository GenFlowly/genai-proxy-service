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
    val previousMessageId: String?
)