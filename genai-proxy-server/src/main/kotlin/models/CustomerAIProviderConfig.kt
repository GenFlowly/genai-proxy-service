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
    val priority: Int,
    /**
     * True when [apiKey] is one of OUR system keys (the admin-panel keyless
     * fallback) rather than the customer's own. Durable request-agent
     * execution is disabled for these: the retrieval server resolves
     * credentials from CustomerVendorApiKeys by customer_id, which only holds
     * customer keys.
     */
    val systemKey: Boolean = false
)
