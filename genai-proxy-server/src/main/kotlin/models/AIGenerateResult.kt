package models

/**
 * Wraps the result of a single AI generation call, carrying both the generated
 * text and normalized token-usage counts extracted from [AIResponse.getUsageMetadata].
 */
data class AIGenerateResult(
    val text: String,
    val inputTokens: Int?,
    val outputTokens: Int?
)
