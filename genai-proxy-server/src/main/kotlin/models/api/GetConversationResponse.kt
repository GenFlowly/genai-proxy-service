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
    val vendorTotals: List<VendorUsageTotals> = emptyList(),
    /**
     * Set when a durable agent run is currently generating this conversation's
     * reply (DURABLE_AGENTS_DBOS_PLAN §5.8). A reloading client reattaches to
     * GET /runs/{pendingRunId}/stream to resume watching the in-flight response.
     */
    val pendingRunId: String? = null
)

/** Conversation-wide token usage and exact USD cost for one AI vendor. */
@Serializable
data class VendorUsageTotals(
    val aiVendor: String,
    val inputTokens: Int,
    val outputTokens: Int,
    val totalTokens: Int,
    val tokensReadFromCache: Int,
    /** Reasoning/thinking tokens — a subset of outputTokens, not additional to it. */
    val reasoningTokens: Int = 0,
    /** Sum of per-message exact costs; null when no message has a computed cost. */
    val costUsd: Double? = null,
    /** Sum of per-message reasoning costs — already included in costUsd, never add the two. */
    val reasoningCostUsd: Double? = null
)


@Serializable
data class PromptAndResponse(
    val prompt: Prompt,
    val responses: List<GenerateTextResponse>? = emptyList(),
    /** ISO-8601 createdAt of the user message that carried this prompt. */
    val promptCreatedAt: String? = null,
    /**
     * Author of the user message. Lets viewers of a shared conversation see
     * who sent each prompt instead of assuming it was themselves.
     */
    val sender: MessageSender? = null
)

/** Display identity of a message author, joined from CustomerProfile. */
@Serializable
data class MessageSender(
    val customerId: String,
    /** Null when the profile has no name (or no longer exists). */
    val name: String? = null,
    val picture: String? = null
)
