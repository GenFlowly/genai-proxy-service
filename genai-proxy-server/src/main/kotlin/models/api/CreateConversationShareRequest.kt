package com.genflowly.models.api

import kotlinx.serialization.Serializable

@Serializable
data class CreateConversationShareRequest(
    val conversationId: String,
    val targetCustomerId: String,
    val role: String = "VIEW"
)
