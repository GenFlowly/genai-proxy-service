package com.genflowly.models.api

import com.genflowly.models.ShareRole
import kotlinx.serialization.Serializable

@Serializable
data class CreateConversationShareRequest(
    val conversationId: String,
    val targetCustomerId: String,
    val role: ShareRole = ShareRole.VIEW
)
