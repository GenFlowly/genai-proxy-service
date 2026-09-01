package com.genflowly.models

import com.genflowly.models.AIVendor
import kotlinx.serialization.Serializable

import kotlinx.serialization.SerialName

@Serializable
data class StoreCustomerVendorApiKeyResponse(
    val apiKeyStatus: AIVendorAPIKeyStatus
)

@Serializable
enum class APIKeyStatus(val value: String) {
    @SerialName("API key is valid")
    VALID("API key is valid"),

    @SerialName("API key is not valid")
    INVALID("API key is not valid"),

    @SerialName("API Key is not set")
    NOT_SET("API Key is not set")
}

@Serializable
data class AIVendorAPIKeyStatus(
    val aiVendor: AIVendor,
    @Deprecated("Use status instead")
    val isAPIKeyValid: Boolean,
    val status: APIKeyStatus,
    val updateSuccessful: Boolean = false,
    // Customer-selected model and failover priority (1 = primary) for
    // internal generations (titles, personas, memory). Null until configured.
    val selectedModel: String? = null,
    val priority: Int? = null
)