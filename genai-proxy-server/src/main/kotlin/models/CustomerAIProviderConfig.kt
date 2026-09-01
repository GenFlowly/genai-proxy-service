package com.genflowly.models

/**
 * One usable customer AI provider: a vendor the customer has a valid stored
 * key for, with their selected model and failover priority (1 = primary).
 * Carries decrypted key material — server-side only, never serialized.
 */
data class CustomerAIProviderConfig(
    val aiVendor: AIVendor,
    val model: String,
    val apiKey: String,
    val priority: Int
)
