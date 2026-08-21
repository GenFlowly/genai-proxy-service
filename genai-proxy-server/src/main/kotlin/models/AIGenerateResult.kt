package com.genflowly.models

/**
 * Wraps the result of a single AI generation call, carrying both the generated
 * text and normalized token-usage counts.
 */
data class AIGenerateResult(
    val text: String,
    val inputTokens: Int?,
    val outputTokens: Int?,
    val totalTokens: Int? = null,
    val tokensReadFromCache: Int? = null
)
