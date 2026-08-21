package com.genflowly.models

import com.genflowly.aicallerlib.models.AIVendor

/**
 * One usable system AI provider: a vendor with a valid stored key, an
 * admin-selected model and a failover priority (1 = primary).
 * Carries decrypted key material — server-side only, never serialized.
 */
data class SystemAIProviderConfig(
    val aiVendor: AIVendor,
    val model: String,
    val apiKey: String,
    val priority: Int
)
