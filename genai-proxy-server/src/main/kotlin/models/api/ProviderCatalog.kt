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
    // Whether the model reads an attached PDF natively (document block) vs. the
    // retrieval-server's fallback (page images for vision models, else extracted
    // text). Lets the UI hint how a PDF will be consumed. Default false when the
    // LiteLLM capability map has no entry.
    val supportsPdfInput: Boolean = false,
    // Whether the model accepts images — gates the page-image PDF fallback for
    // non-native models. Default false when unknown.
    val supportsVision: Boolean = false,
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

/**
 * Embedding-model pricing catalog from the retrieval server's
 * /embedding-providers — the embedding-mode counterpart of /providers, used
 * only to seed AIModelCatalog pricing rows for Cost and Usage (see
 * ModelCatalogService's embedding sync step). No tool/vision/PDF capability
 * fields — embeddings don't have them.
 */
@Serializable
data class EmbeddingProviderModelInfo(
    val name: String,
    val inputCostPerMTok: Double? = null
)

@Serializable
data class EmbeddingProviderInfo(
    val id: String,
    val models: List<EmbeddingProviderModelInfo>
)

@Serializable
data class EmbeddingProviderCatalogResponse(
    val providers: List<EmbeddingProviderInfo>
)
