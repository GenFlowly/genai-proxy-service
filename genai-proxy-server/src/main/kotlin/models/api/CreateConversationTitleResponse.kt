package com.genflowly.models.api

import kotlinx.serialization.Serializable

@Serializable
data class CreateConversationTitleResponse(
    val title: String?
)
