package com.genflowly.models.api

import kotlinx.serialization.Serializable

/**
 * One breakdown row for the Cost and Usage pages — either grouped by vendor
 * (model is "" — not meaningful at that grouping level) or by vendor+model.
 */
@Serializable
data class UsageByDimResponse(
    val vendor: String,
    val model: String = "",
    val costUsd: Double,
    val totalTokens: Long? = null,
    val inputTokens: Long? = null,
    val outputTokens: Long? = null,
    val cacheReadTokens: Long? = null,
    val cacheWriteTokens: Long? = null,
    val requestCount: Long
)

/**
 * One UTC day of spend inside the requested window, for the Cost and Usage
 * bar chart. Days with no usage are left out; the client fills the gaps and
 * groups into weeks for long windows.
 */
@Serializable
data class UsageDayResponse(
    val date: String,
    val costUsd: Double,
    val requestCount: Long
)

@Serializable
data class LlmUsageSummaryResponse(
    val totalCostUsd: Double,
    val byVendor: List<UsageByDimResponse>,
    val byModel: List<UsageByDimResponse>,
    val byDay: List<UsageDayResponse> = emptyList()
)

@Serializable
data class EmbeddingUsageSummaryResponse(
    val totalCostUsd: Double,
    val byVendor: List<UsageByDimResponse>,
    val byModel: List<UsageByDimResponse>,
    val byDay: List<UsageDayResponse> = emptyList()
)

/** One estimate-breakdown row: opType (vector_db) or searchDepth (web_search). */
@Serializable
data class EstimatedUsageBreakdownRow(
    val key: String,
    val count: Long,
    val costUsd: Double
)

/**
 * Web Search totals: priced at READ time from UsageRateCard against raw
 * credit counts, never a real vendor bill — [isEstimate] is always true and
 * must stay visible in the UI.
 */
@Serializable
data class EstimatedUsageSummaryResponse(
    val totalCostUsd: Double,
    val isEstimate: Boolean = true,
    val breakdown: List<EstimatedUsageBreakdownRow>
)

/** One operation-type row: raw count only, no dollar figure. */
@Serializable
data class VectorDbUsageBreakdownRow(
    val opType: String,
    val count: Long
)

/**
 * Vector DB totals: Zilliz bills by data size/compute units, not per
 * operation call, so a count can never be converted into a meaningful dollar
 * estimate — this intentionally carries no cost field at all, only raw
 * operation-volume counts.
 */
@Serializable
data class VectorDbUsageSummaryResponse(
    val breakdown: List<VectorDbUsageBreakdownRow>
)

/**
 * Admin-panel view of the UsageRateCard table: current per-unit USD rates
 * for the two read-time-priced categories (vector_db op counts, web_search
 * credits). Both categories are returned together since the admin UI edits
 * them from one page.
 */
@Serializable
data class UsageRateCardEntry(
    val category: String,
    val rateKey: String,
    val usdRate: Double
)

@Serializable
data class GetUsageRateCardResponse(
    val rates: List<UsageRateCardEntry>
)

@Serializable
data class PutUsageRateCardRequest(
    val category: String,
    val rateKey: String,
    val usdRate: Double
)
