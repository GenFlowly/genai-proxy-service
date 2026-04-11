package com.genflowly.models.api

import kotlinx.serialization.Serializable

@Serializable
data class CreateConversationTitleRequest(
    val conversationId: String,
    val prompt: String,
    val instructionName: String? = null
)
