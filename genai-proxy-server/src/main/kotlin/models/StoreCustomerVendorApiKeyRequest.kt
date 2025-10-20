package models

import kotlinx.serialization.Serializable

@Serializable
data class StoreCustomerVendorApiKeyRequest(
    val customerId: String,
    val aiVendor: String,
    val apiKey: String
)