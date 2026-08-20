package models

/**
 * One row of the AIModelCatalog table: token limits and pricing for a
 * vendor's model. Costs are USD per 1M tokens.
 */
data class ModelCatalogEntry(
    val model: String,
    val maxOutputTokens: Int?,
    val maxInputTokens: Int?,
    val inputCostPerMTok: Double? = null,
    val outputCostPerMTok: Double? = null,
    val cacheReadCostPerMTok: Double? = null,
    val cacheWriteCostPerMTok: Double? = null
)
