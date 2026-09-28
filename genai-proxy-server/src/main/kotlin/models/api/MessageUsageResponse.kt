package com.genflowly.models.api

import kotlinx.serialization.Serializable

/** Token usage + exact cost for a single message (GET /api/v1/message/usage). */
@Serializable
data class MessageUsageResponse(
    val inputTokens: Int? = null,
    val outputTokens: Int? = null,
    val totalTokens: Int? = null,
    val tokensReadFromCache: Int? = null,
    /** Reasoning/thinking tokens — a subset of outputTokens, not additional to it. */
    val reasoningTokens: Int? = null,
    val costUsd: Double? = null,
    /** USD spent on the reasoning subset — already included in costUsd, never add the two. */
    val reasoningCostUsd: Double? = null
)
