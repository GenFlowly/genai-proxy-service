package com.genflowly.models.api

import kotlinx.serialization.Serializable

@Serializable
data class ForkConversationResponse(
    val conversationId: String,
    val title: String,
    val parentConversationId: String,
    val projectId: String? = null,
    val pinnedAt: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null
)
