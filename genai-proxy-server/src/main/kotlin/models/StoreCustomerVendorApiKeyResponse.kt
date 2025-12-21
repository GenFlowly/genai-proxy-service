package models

import com.genflowly.aicallerlib.models.AIVendor
import kotlinx.serialization.Serializable

@Serializable
data class StoreCustomerVendorApiKeyResponse(
    val apiKeyResponse: AIVendorAPIKeyResponse
)

@Serializable
data class AIVendorAPIKeyResponse(
    val aiVendor: AIVendor,
    val isAPIKeyValid: Boolean
)