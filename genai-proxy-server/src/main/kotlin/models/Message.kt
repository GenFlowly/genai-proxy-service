package models

import com.genflowly.aicallerlib.models.AIVendor
import java.util.UUID

data class Message(
    val messageId: String = UUID.randomUUID().toString(),
    val conversationId: String,
    val vendor: AIVendor,
    val text: String,
    val sequence: Int,
    val client: String,
    val role: String,
    val customerId: String,
    val previousMessageId: String?
)