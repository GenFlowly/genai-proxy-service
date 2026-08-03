package com.genflowly.models.api

import kotlinx.serialization.Serializable
import models.GenerateTextResponse
import models.Prompt

@Serializable
data class GetConversationResponse(
    val promptAndResponseList: List<PromptAndResponse>,
    val title: String? = null,
    /** Caller's role on this conversation: OWNER, EDIT, or VIEW. */
    val role: String = "OWNER"
)


@Serializable
data class PromptAndResponse(
    val prompt: Prompt,
    val responses: List<GenerateTextResponse>? = emptyList()
)
