package com.genflowly.service

import com.genflowly.models.AIVendor
import mu.KotlinLogging
import kotlin.math.roundToLong

private val logger = KotlinLogging.logger {}

/**
 * The vendor-reported token counts for one generation turn, in the vendors'
 * own billing buckets.
 *
 * Text-only turns carry the langchain-normalized totals: [inputTokens]
 * INCLUDES the [cacheReadTokens] and [tokensWrittenToCache] subsets.
 *
 * Voice turns additionally carry the modality breakdown ([inputTextTokens]
 * etc.); there, input_*_tokens include the cached_*_tokens subsets, matching
 * the OpenAI Realtime / Gemini Live usage payloads.
 */
data class TokenUsageBreakdown(
    val inputTokens: Int?,
    val outputTokens: Int?,
    val cacheReadTokens: Int? = null,
    val tokensWrittenToCache: Int? = null,
    val inputTextTokens: Int? = null,
    val inputAudioTokens: Int? = null,
    val cachedTextTokens: Int? = null,
    val cachedAudioTokens: Int? = null,
    val outputTextTokens: Int? = null,
    val outputAudioTokens: Int? = null
)

/**
 * Computes the exact USD cost of a generation turn: the vendor-reported token
 * buckets priced at the AIModelCatalog rates (USD per 1M tokens). This is the
 * same arithmetic the vendors' own billing dashboards apply — no vendor API
 * returns a dollar amount per request.
 *
 * Returns null (never a guess) when the model has no catalog pricing; the
 * catalog is refreshed daily from the live LiteLLM price map and can be
 * corrected through the admin panel.
 */
class CostCalculationService(
    private val modelCatalogService: ModelCatalogService
) {

    suspend fun computeCostUsd(vendor: AIVendor, model: String, usage: TokenUsageBreakdown): Double? {
        if ((usage.inputTokens ?: 0) == 0 && (usage.outputTokens ?: 0) == 0) return null

        val entry = modelCatalogService.getCatalogEntry(vendor, model)
        if (entry?.inputCostPerMTok == null && entry?.outputCostPerMTok == null) {
            logger.warn { "No catalog pricing for ${vendor.name}/$model — costUsd not computed" }
            return null
        }

        val inRate = entry.inputCostPerMTok ?: 0.0
        val outRate = entry.outputCostPerMTok ?: 0.0
        // Missing cache rates fall back to the base input rate (never cheaper
        // than reality); missing audio rates fall back to the text rates.
        val cacheReadRate = entry.cacheReadCostPerMTok ?: inRate
        val cacheWriteRate = entry.cacheWriteCostPerMTok ?: inRate
        val inAudioRate = entry.inputAudioCostPerMTok ?: inRate
        val outAudioRate = entry.outputAudioCostPerMTok ?: outRate
        val cacheReadAudioRate = entry.cacheReadAudioCostPerMTok ?: cacheReadRate

        val hasModalityBreakdown = listOf(
            usage.inputTextTokens, usage.inputAudioTokens,
            usage.outputTextTokens, usage.outputAudioTokens
        ).any { (it ?: 0) > 0 }

        val cost = if (hasModalityBreakdown) {
            val cachedText = usage.cachedTextTokens ?: 0
            val cachedAudio = usage.cachedAudioTokens ?: 0
            val freshText = ((usage.inputTextTokens ?: 0) - cachedText).coerceAtLeast(0)
            val freshAudio = ((usage.inputAudioTokens ?: 0) - cachedAudio).coerceAtLeast(0)
            perMTok(freshText, inRate) +
                perMTok(freshAudio, inAudioRate) +
                perMTok(cachedText, cacheReadRate) +
                perMTok(cachedAudio, cacheReadAudioRate) +
                perMTok(usage.outputTextTokens ?: 0, outRate) +
                perMTok(usage.outputAudioTokens ?: 0, outAudioRate)
        } else {
            val cacheRead = usage.cacheReadTokens ?: 0
            val cacheWrite = usage.tokensWrittenToCache ?: 0
            val fresh = ((usage.inputTokens ?: 0) - cacheRead - cacheWrite).coerceAtLeast(0)
            perMTok(fresh, inRate) +
                perMTok(cacheRead, cacheReadRate) +
                perMTok(cacheWrite, cacheWriteRate) +
                perMTok(usage.outputTokens ?: 0, outRate)
        }

        // 10 decimal places — far below a micro-cent, avoids float noise in DDB
        return (cost * 1e10).roundToLong() / 1e10
    }

    private fun perMTok(tokens: Int, ratePerMTok: Double): Double =
        tokens * ratePerMTok / 1_000_000.0
}
