package com.genflowly.models

/**
 * Single home for AIVendor <-> external-identifier mappings (LiteLLM provider
 * strings and llm_credentials keys used by the retrieval-server).
 */

/**
 * LiteLLM provider string used in retrieval-server payloads. Legacy vendors
 * have bespoke mappings; long-tail vendor names ARE lowercase LiteLLM ids.
 */
fun AIVendor.toProviderString(): String = when (this) {
    AIVendor.OPENAI -> "openai"
    AIVendor.GEMINI -> "gemini"
    AIVendor.CLAUDE -> "anthropic"
    else -> name.lowercase()
}

/** The llm_credentials map key the retrieval-server expects for this vendor. */
fun AIVendor.toCredentialKey(): String = "${toProviderString()}_api_key"

/** Inverse of [toProviderString]. */
fun aiVendorFromProviderString(provider: String): AIVendor = AIVendor.of(provider)
