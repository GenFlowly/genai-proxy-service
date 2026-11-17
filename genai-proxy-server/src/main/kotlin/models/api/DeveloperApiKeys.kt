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

/**
 * One key and what its requests cost: the last 30 days (UTC) and all time.
 * The usage fields are null when usage couldn't be read; usage before
 * per-key tracking started isn't attributed to any key.
 */
@Serializable
data class DeveloperApiKeySummary(
    val keyId: String,
    val name: String,
    val prefix: String,
    val createdAt: String? = null,
    val lastUsedAt: String? = null,
    val requests30d: Long? = null,
    val costUsd30d: Double? = null,
    val requestsAllTime: Long? = null,
    val costUsdAllTime: Double? = null
)

/** Sums over every listed key; null fields when no key's usage could be read. */
@Serializable
data class DeveloperApiKeyUsageTotals(
    val requests30d: Long? = null,
    val costUsd30d: Double? = null,
    val requestsAllTime: Long? = null,
    val costUsdAllTime: Double? = null
) {
    companion object {
        fun of(keys: List<DeveloperApiKeySummary>): DeveloperApiKeyUsageTotals {
            val read = keys.filter { it.requests30d != null }
            if (read.isEmpty()) return DeveloperApiKeyUsageTotals()
            return DeveloperApiKeyUsageTotals(
                requests30d = read.sumOf { it.requests30d ?: 0L },
                costUsd30d = read.sumOf { it.costUsd30d ?: 0.0 },
                requestsAllTime = read.sumOf { it.requestsAllTime ?: 0L },
                costUsdAllTime = read.sumOf { it.costUsdAllTime ?: 0.0 }
            )
        }
    }
}

@Serializable
data class ListDeveloperApiKeysResponse(
    val keys: List<DeveloperApiKeySummary>,
    val totals: DeveloperApiKeyUsageTotals = DeveloperApiKeyUsageTotals()
)
