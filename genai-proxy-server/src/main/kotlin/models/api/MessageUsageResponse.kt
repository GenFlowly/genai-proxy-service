package com.genflowly.models.api

import kotlinx.serialization.Serializable

/** Token usage + exact cost for a single message (GET /api/v1/message/usage). */
@Serializable
data class MessageUsageResponse(
    val inputTokens: Int? = null,
    val outputTokens: Int? = null,
    val totalTokens: Int? = null,
    val tokensReadFromCache: Int? = null,
    val costUsd: Double? = null
)
