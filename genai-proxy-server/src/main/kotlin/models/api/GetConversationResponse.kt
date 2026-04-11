package com.genflowly.models.api

import kotlinx.serialization.Serializable
import models.GenerateTextResponse
import models.Prompt

@Serializable
data class GetConversationResponse(
    val promptAndResponseList: List<PromptAndResponse>,
    val title: String? = null
)


@Serializable
data class PromptAndResponse(
    val prompt: Prompt,
    val response: GenerateTextResponse
)

