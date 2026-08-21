package com.genflowly.models.api

import com.genflowly.models.ShareRole
import kotlinx.serialization.Serializable
import com.genflowly.models.GenerateTextResponse
import com.genflowly.models.Prompt

@Serializable
data class GetConversationResponse(
    val promptAndResponseList: List<PromptAndResponse>,
    val title: String? = null,
    /** Caller's role on this conversation: OWNER, EDIT, or VIEW. */
    val role: ShareRole = ShareRole.OWNER
)


@Serializable
data class PromptAndResponse(
    val prompt: Prompt,
    val responses: List<GenerateTextResponse>? = emptyList(),
    /** ISO-8601 createdAt of the user message that carried this prompt. */
    val promptCreatedAt: String? = null
)
