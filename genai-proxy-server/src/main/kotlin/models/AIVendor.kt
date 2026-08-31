package com.genflowly.models

import kotlinx.serialization.Serializable

/**
 * AI vendors this product supports. Serializes by name ("OPENAI"/"CLAUDE"/
 * "GEMINI"), matching both the API wire format and the vendor keys stored in
 * DynamoDB. Mappings to the retrieval-server's provider identifiers live in
 * AIVendorMappings.kt.
 */
@Serializable
enum class AIVendor {
    OPENAI,
    CLAUDE,
    GEMINI
}
