package com.genflowly.models

import kotlinx.serialization.Serializable

@Serializable
data class StoreCustomerVendorApiKeyRequest(
    val aiVendor: String,
    val apiKey: String
)