package com.genflowly.models

import kotlinx.serialization.Serializable

@Serializable
data class StoreCustomerVendorApiKeyRequest(
    val aiVendor: String,
    val apiKey: String
)

/**
 * Customer's model + failover priority (1 = primary) for a vendor they have a
 * stored key for. Used by internal generations (titles, personas, memory).
 */
@Serializable
data class StoreCustomerVendorConfigRequest(
    val aiVendor: String,
    val model: String,
    val priority: Int
)