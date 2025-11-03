package models

import java.util.UUID

data class Conversation(
    val conversationId: String = UUID.randomUUID().toString(),
    val customerId: String,
    val client: String
)