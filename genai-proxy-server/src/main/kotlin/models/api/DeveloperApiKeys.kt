package com.genflowly.models.api

import kotlinx.serialization.Serializable

@Serializable
data class CreateDeveloperApiKeyRequest(
    val name: String
)

/**
 * Returned once at creation time — the only moment [apiKey] is ever exposed.
 */
@Serializable
data class DeveloperApiKeyCreatedResponse(
    val keyId: String,
    val name: String,
    val apiKey: String,
    val prefix: String,
    val createdAt: String
)

@Serializable
data class DeveloperApiKeySummary(
    val keyId: String,
    val name: String,
    val prefix: String,
    val createdAt: String? = null,
    val lastUsedAt: String? = null
)

@Serializable
data class ListDeveloperApiKeysResponse(
    val keys: List<DeveloperApiKeySummary>
)
