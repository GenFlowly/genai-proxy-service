package com.genflowly.service

import com.genflowly.models.AIVendor
import com.genflowly.models.toProviderString
import com.genflowly.repository.CustomerProfileRepository
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

/**
 * Admin-curated allowlist of AI vendors customers may see and use in the
 * react-app (Model API Keys dropdown, key-status cards, sidebar widget).
 *
 * Semantics: entries are provider catalog ids (LiteLLM ids — "openai",
 * "anthropic", "xai", ...). An allowlist that was never configured, or that
 * is empty, means ALL vendors are allowed — an accidental lockout of every
 * customer must not be one unchecked box away.
 */
class VendorAllowlistService(
    private val customerProfileRepository: CustomerProfileRepository
) {
    @Volatile
    private var cache: Pair<Long, Set<String>?>? = null

    /** Allowed catalog ids, or null when everything is allowed. */
    suspend fun getAllowedProviderIds(): Set<String>? {
        val now = System.currentTimeMillis()
        cache?.let { (fetchedAt, ids) -> if (now - fetchedAt < CACHE_TTL_MS) return ids }
        val stored = runCatching { customerProfileRepository.getVendorAllowlist() }
            .onFailure { logger.warn(it) { "Vendor allowlist read failed — treating as all-allowed" } }
            .getOrNull()
        val ids = stored?.takeIf { it.isNotEmpty() }?.map { it.lowercase() }?.toSet()
        cache = now to ids
        return ids
    }

    suspend fun saveAllowedProviderIds(providerIds: List<String>, updatedBy: String) {
        val normalized = providerIds.map { it.lowercase().trim() }.filter { it.isNotEmpty() }.distinct()
        customerProfileRepository.saveVendorAllowlist(normalized, updatedBy)
        cache = null
    }

    /** Whether a vendor (by AIVendor id or catalog id) is visible to customers. */
    suspend fun isAllowed(vendor: AIVendor): Boolean {
        val allowed = getAllowedProviderIds() ?: return true
        return vendor.toProviderString() in allowed
    }

    companion object {
        // Admin saves must show up promptly without a DDB read per request
        private const val CACHE_TTL_MS = 30_000L
    }
}
