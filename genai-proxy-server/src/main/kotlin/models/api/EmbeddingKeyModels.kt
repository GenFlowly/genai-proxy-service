package com.genflowly.models

import kotlinx.serialization.Serializable

/**
 * Providers a customer can bring an embedding API key for. OPENAI shares its
 * key with the text-generation vendor of the same name (one key, stored once
 * in CustomerVendorApiKeys); VOYAGE is embedding-only and lives outside the
 * [AIVendor] enum so it never shows up in text-generation vendor lists or
 * failover chains.
 */
@Serializable
enum class EmbeddingVendor {
    OPENAI,
    VOYAGE;

    /** Retrieval-server provider string used for key validation. */
    fun toProviderString(): String = when (this) {
        OPENAI -> "openai"
        VOYAGE -> "voyage"
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
