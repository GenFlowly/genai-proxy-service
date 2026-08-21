package com.genflowly.models

import com.genflowly.models.AIVendor

/**
 * Single home for AIVendor <-> external-identifier mappings (LiteLLM provider
 * strings and llm_credentials keys used by the retrieval-server).
 */

/** LiteLLM provider string used in retrieval-server payloads. */
fun AIVendor.toProviderString(): String = when (this) {
    AIVendor.OPENAI -> "openai"
    AIVendor.GEMINI -> "gemini"
    AIVendor.CLAUDE -> "anthropic"
}

/** The llm_credentials map key the retrieval-server expects for this vendor. */
fun AIVendor.toCredentialKey(): String = when (this) {
    AIVendor.OPENAI -> "openai_api_key"
    AIVendor.GEMINI -> "gemini_api_key"
    AIVendor.CLAUDE -> "anthropic_api_key"
}

/** Inverse of [toProviderString]; null for unknown provider strings. */
fun aiVendorFromProviderString(provider: String): AIVendor? = when (provider) {
    "openai" -> AIVendor.OPENAI
    "gemini" -> AIVendor.GEMINI
    "anthropic" -> AIVendor.CLAUDE
    else -> null
}
