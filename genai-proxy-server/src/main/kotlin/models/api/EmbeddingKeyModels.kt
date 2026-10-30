package com.genflowly.models

import kotlinx.serialization.Serializable

/**
 * Providers a customer can bring an embedding API key for. OPENAI shares its
 * key with the text-generation vendor of the same name (one key, stored once
 * in CustomerVendorApiKeys); VOYAGE is embedding-only and lives outside the
 * [AIVendor] enum so it never shows up in text-generation vendor lists or
 * failover chains. HUGGINGFACE is not an embedding provider: it is an optional
 * Hugging Face Hub token the retrieval server uses to authenticate tokenizer
 * downloads for Voyage models. It shares this credential flow and table but is
 * never validated, probed, or offered as a model source.
 */
@Serializable
enum class EmbeddingVendor {
    OPENAI,
    VOYAGE,
    HUGGINGFACE;

    /** False for HUGGINGFACE — a Hub download token, not an embedding key. */
    val embeds: Boolean get() = this != HUGGINGFACE

    /** Retrieval-server provider string used for key validation. */
    fun toProviderString(): String = when (this) {
        OPENAI -> "openai"
        VOYAGE -> "voyage"
        HUGGINGFACE -> error("HUGGINGFACE is a Hub token — it has no embedding provider to validate against")
    }
}

@Serializable
data class StoreCustomerEmbeddingKeyRequest(
    val vendor: EmbeddingVendor,
    val apiKey: String
)

@Serializable
data class EmbeddingKeyStatus(
    val vendor: EmbeddingVendor,
    val isAPIKeyValid: Boolean,
    val status: APIKeyStatus,
    val updateSuccessful: Boolean = false,
    /** Provider's rejection message when validation fails. */
    val detail: String? = null
)

@Serializable
data class StoreCustomerEmbeddingKeyResponse(
    val keyStatus: EmbeddingKeyStatus
)

@Serializable
data class GetCustomerEmbeddingKeysResponse(
    val statuses: List<EmbeddingKeyStatus>
)

@Serializable
data class EmbeddingVendorModels(
    val vendor: EmbeddingVendor,
    val models: List<String>
)

@Serializable
data class GetEmbeddingModelsResponse(
    val vendorModels: List<EmbeddingVendorModels>
)
