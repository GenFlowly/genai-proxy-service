package com.genflowly.models.api

import kotlinx.serialization.Serializable

/**
 * BYOK vendor catalog, passed through from the retrieval server's /providers:
 * every provider the platform can call (native langchain tier + the LiteLLM
 * long tail), with chat models and per-model tool-calling support.
 */
@Serializable
data class ProviderModelInfo(
    val name: String,
    val supportsTools: Boolean,
    // Token limits + pricing (USD per 1M tokens) from the LiteLLM price map;
    // feeds pricing-only AIModelCatalog rows for long-tail BYOK vendors.
    val maxInputTokens: Int? = null,
    val maxOutputTokens: Int? = null,
    val inputCostPerMTok: Double? = null,
    val outputCostPerMTok: Double? = null,
    val cacheReadCostPerMTok: Double? = null,
    val cacheWriteCostPerMTok: Double? = null,
    val inputAudioCostPerMTok: Double? = null,
    val outputAudioCostPerMTok: Double? = null,
    val cacheReadAudioCostPerMTok: Double? = null
)

@Serializable
data class ProviderInfo(
    val id: String,
    val displayName: String,
    val native: Boolean,
    val models: List<ProviderModelInfo>
)

@Serializable
data class ProviderCatalogResponse(
    val providers: List<ProviderInfo>
)
