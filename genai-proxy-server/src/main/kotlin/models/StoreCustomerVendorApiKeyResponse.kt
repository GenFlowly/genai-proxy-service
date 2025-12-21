package models

import com.genflowly.aicallerlib.models.AIVendor
import kotlinx.serialization.Serializable

@Serializable
data class StoreCustomerVendorApiKeyResponse(
    val apiKeyStatus: AIVendorAPIKeyStatus
)

@Serializable
data class AIVendorAPIKeyStatus(
    val aiVendor: AIVendor,
    val isAPIKeyValid: Boolean
)