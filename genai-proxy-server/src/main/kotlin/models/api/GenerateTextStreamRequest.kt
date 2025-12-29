package com.genflowly.models.api

import kotlinx.serialization.Serializable
import models.AIConfig
import models.Prompt

@Serializable
data class GenerateTextStreamRequest(
    val aiConfig: AIConfig,
    val prompt: Prompt,
    val selectedResponseId: String?,
    val conversationId: String?,
    val client: String
)
