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
    val role: ShareRole = ShareRole.OWNER,
    /** Whole-conversation usage + exact cost, one entry per AI vendor that responded. */
    val vendorTotals: List<VendorUsageTotals> = emptyList()
)

/** Conversation-wide token usage and exact USD cost for one AI vendor. */
@Serializable
data class VendorUsageTotals(
    val aiVendor: String,
    val inputTokens: Int,
    val outputTokens: Int,
    val totalTokens: Int,
    val tokensReadFromCache: Int,
    /** Sum of per-message exact costs; null when no message has a computed cost. */
    val costUsd: Double? = null
)


@Serializable
data class PromptAndResponse(
    val prompt: Prompt,
    val responses: List<GenerateTextResponse>? = emptyList(),
    /** ISO-8601 createdAt of the user message that carried this prompt. */
    val promptCreatedAt: String? = null
)
