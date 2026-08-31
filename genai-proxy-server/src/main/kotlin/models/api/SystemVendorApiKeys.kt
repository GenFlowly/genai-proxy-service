package com.genflowly.models

import com.genflowly.models.AIVendor
import kotlinx.serialization.Serializable

@Serializable
data class StoreSystemVendorApiKeyRequest(
    val aiVendor: String,
    val apiKey: String
)

@Serializable
data class StoreSystemVendorApiKeyResponse(
    val apiKeyStatus: AIVendorAPIKeyStatus
)

/**
 * Per-vendor system key status plus the admin-selected model and failover
 * priority (1 = primary). Key material is never included.
 */
@Serializable
data class SystemVendorApiKeyInfo(
    val aiVendor: AIVendor,
    val isAPIKeyValid: Boolean,
    val status: APIKeyStatus,
    val selectedModel: String? = null,
    val priority: Int? = null
)

@Serializable
data class GetSystemVendorApiKeyStatusListResponse(
    val apiKeyStatuses: List<SystemVendorApiKeyInfo>
)

@Serializable
data class SystemVendorModelsResponse(
    val aiVendor: AIVendor,
    val models: List<String>
)

@Serializable
data class StoreSystemVendorConfigRequest(
    val aiVendor: String,
    val model: String,
    val priority: Int
)
