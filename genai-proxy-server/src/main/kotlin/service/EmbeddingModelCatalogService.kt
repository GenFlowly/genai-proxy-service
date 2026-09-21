package com.genflowly.service

import com.genflowly.DynamoDBConstants.AI_VENDOR_KEY
import com.genflowly.DynamoDBConstants.CUSTOMER_ID_KEY
import com.genflowly.models.EmbeddingVendor
import com.genflowly.providers.KMSProvider
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.repository.CustomerCredentialsRepository
import com.genflowly.repository.EmbeddingModelCatalogRepository
import com.genflowly.repository.ProbedModels
import java.security.MessageDigest
import java.time.Duration
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

/**
 * The source of truth for "which embedding models can this customer's key
 * actually embed?" — replacing the old hardcoded allowlist, which could drift
 * from the vendor SDKs the encoding pipeline uses.
 *
 * The list is discovered by probing (retrieval-server /probe-embedding-models
 * makes a one-token embed per candidate against the same vendor endpoint the
 * encoder uses), cached per (customer, vendor) in DDB, and refreshed:
 *   - on key add (fire-and-forget from CustomerCredentialsService),
 *   - lazily when read and stale (stale-while-revalidate),
 *   - and by a weekly sweep ([startWeeklyRefresh]) that catches a vendor
 *     deprecating a model a customer already selected.
 *
 * Callers get the probed list, never the raw LiteLLM catalog — that catalog is
 * only the candidate universe fed to the probe.
 */
class EmbeddingModelCatalogService(
    private val kmsProvider: KMSProvider,
    private val customerCredentialsRepository: CustomerCredentialsRepository,
    private val embeddingModelCatalogRepository: EmbeddingModelCatalogRepository,
    private val retrievalServerClient: RetrievalServerClient,
    private val appScope: CoroutineScope
) {
    companion object {
        private val STALE_AFTER: Duration = Duration.ofDays(7)
        private const val REFRESH_INTERVAL_MS = 7L * 24 * 60 * 60 * 1000
        // Short mutual-exclusion lease during a run; self-heals if the holder crashes.
        private const val SWEEP_LEASE_MS = 60L * 60 * 1000
        // After a successful sweep, block the next one for ~a week.
        private const val SWEEP_COOLDOWN_MS = REFRESH_INTERVAL_MS
    }

    /** Stable 16-hex-char fingerprint of a key, so a rotation invalidates the cache. */
    fun fingerprint(decryptedKey: String): String =
        MessageDigest.getInstance("SHA-256")
            .digest(decryptedKey.toByteArray())
            .joinToString("") { "%02x".format(it) }
            .take(16)

    /** voyage-* -> VOYAGE, text-embedding-* -> OPENAI, else null (bogus name). */
    fun vendorForModel(modelName: String): EmbeddingVendor? = when {
        modelName.startsWith("voyage") -> EmbeddingVendor.VOYAGE
        modelName.startsWith("text-embedding") -> EmbeddingVendor.OPENAI
        else -> null
    }

    /**
     * The models [vendor]'s key can embed for this customer, or null when it
     * genuinely couldn't be determined (probe infra down and no cache) — callers
     * distinguish "no models" from "don't know". Serves the cache when the key
     * is unchanged (refreshing in the background if stale); otherwise (cold start
     * or rotated key) probes inline.
     */
    suspend fun getValidModels(
        customerId: String,
        vendor: EmbeddingVendor,
        decryptedKey: String
    ): List<String>? {
        val fp = fingerprint(decryptedKey)
        val existing = runCatching { embeddingModelCatalogRepository.getProbed(customerId, vendor.name) }.getOrNull()

        if (existing != null && existing.keyFingerprint == fp) {
            if (isStale(existing.lastProbedAt)) {
                // stale-while-revalidate: serve now, refresh out of band.
                appScope.launch {
                    runCatching { probeAndStore(customerId, vendor, decryptedKey, existing) }
                        .onFailure { logger.warn(it) { "Background embedding re-probe failed for $customerId/$vendor" } }
                }
            }
            return existing.models
        }

        // Cold start or rotated key: probe now. On failure fall back to any prior
        // list (soft — old models are likely still valid for the same vendor);
        // null only when there is nothing at all to serve.
        return probeAndStore(customerId, vendor, decryptedKey, existing) ?: existing?.models
    }

    /**
     * Probe [vendor] with [decryptedKey], persist the result, and return the new
     * valid list. Returns null on transport failure or a vendor-level error
     * (e.g. auth) — the prior list is left untouched in that case.
     */
    suspend fun probeAndStore(
        customerId: String,
        vendor: EmbeddingVendor,
        decryptedKey: String,
        existing: ProbedModels?
    ): List<String>? {
        val provider = vendor.toProviderString()
        val result = retrievalServerClient
            .probeEmbeddingModels(mapOf(provider to decryptedKey))
            .firstOrNull { it.provider == provider }
            ?: run {
                logger.warn { "Embedding probe returned no result for $customerId/$vendor — keeping prior list" }
                return null
            }
        if (result.error != null) {
            logger.warn { "Embedding probe for $customerId/$vendor errored: ${result.error} — keeping prior list" }
            return null
        }

        // supported ∪ (previouslyValid ∩ inconclusive): keep models that only
        // failed transiently this round so a rate-limit blip can't drop them.
        val prev = existing?.models.orEmpty().toSet()
        val merged = (result.supported.toSet() + result.inconclusive.filter { it in prev }).sorted()

        runCatching {
            embeddingModelCatalogRepository.putProbed(customerId, vendor.name, merged, fingerprint(decryptedKey))
        }.onFailure { logger.warn(it) { "Failed to persist probed embedding models for $customerId/$vendor" } }

        logger.info { "Probed ${merged.size} embedding models for $customerId/$vendor" }
        return merged
    }

    /** Decrypts the customer's stored key for [vendor], or null when unset. */
    suspend fun decryptedKeyFor(customerId: String, vendor: EmbeddingVendor): String? {
        val encrypted = customerCredentialsRepository.getCustomerApiKey(vendor.name, customerId) ?: return null
        return runCatching { kmsProvider.decrypt(encrypted) }.getOrNull()?.takeIf { it.isNotBlank() }
    }

    /**
     * Fire-and-forget probe after a key is added/rotated, so the dropdown is
     * accurate by the time the customer opens the model picker.
     */
    fun probeOnKeyChangeAsync(customerId: String, vendor: EmbeddingVendor, decryptedKey: String) {
        appScope.launch {
            runCatching {
                val existing = embeddingModelCatalogRepository.getProbed(customerId, vendor.name)
                probeAndStore(customerId, vendor, decryptedKey, existing)
            }.onFailure { logger.warn(it) { "Post-key-add embedding probe failed for $customerId/$vendor" } }
        }
    }

    /**
     * Throws IllegalArgumentException if [modelName] is set but not embeddable by
     * this customer's key — the save-time gate. Blank clears/leaves a preference
     * and is always allowed. When the valid set can't be determined (probe infra
     * down, no cache) the save is allowed rather than blocked.
     */
    suspend fun assertModelSupported(customerId: String, modelName: String?) {
        if (modelName.isNullOrBlank()) return
        val vendor = vendorForModel(modelName)
            ?: throw IllegalArgumentException("Unknown embedding model '$modelName'")
        val key = decryptedKeyFor(customerId, vendor)
            ?: throw IllegalArgumentException(
                "No ${vendor.name} embedding key is configured — add the key before selecting a $vendor model"
            )
        val valid = getValidModels(customerId, vendor, key) ?: return // undetermined -> don't block
        if (modelName !in valid) {
            throw IllegalArgumentException(
                "Embedding model '$modelName' is not supported by your ${vendor.name} key. " +
                    "Supported: ${valid.joinToString(", ")}"
            )
        }
    }

    /**
     * Re-probe every customer/vendor that has an embedding key. Lease-guarded so
     * only one proxy instance sweeps, and rate-limited to ~weekly via the lease
     * cooldown. Best-effort per row — one failure never aborts the rest.
     */
    suspend fun refreshAll() {
        if (!embeddingModelCatalogRepository.tryAcquireSweepLease(SWEEP_LEASE_MS)) {
            logger.info { "Embedding model sweep skipped: lease held (another instance, or <1 week since last sweep)" }
            return
        }
        var completed = false
        try {
            val vendorNames = EmbeddingVendor.entries.map { it.name }.toSet()
            val items = customerCredentialsRepository.scanEmbeddingKeyItems(vendorNames)
            logger.info { "Embedding model sweep starting: ${items.size} key row(s) to probe" }

            var probed = 0
            var skipped = 0
            for (item in items) {
                val customerId = item[CUSTOMER_ID_KEY]?.s()
                val vendorName = item[AI_VENDOR_KEY]?.s()
                val encrypted = item["apiKey"]?.s()
                val vendor = vendorName?.let { name -> EmbeddingVendor.entries.firstOrNull { it.name == name } }
                if (customerId == null || vendor == null || encrypted.isNullOrBlank()) {
                    skipped++; continue
                }
                val decrypted = runCatching { kmsProvider.decrypt(encrypted) }.getOrNull()?.takeIf { it.isNotBlank() }
                if (decrypted == null) { skipped++; continue }
                val existing = runCatching { embeddingModelCatalogRepository.getProbed(customerId, vendor.name) }.getOrNull()
                val res = runCatching { probeAndStore(customerId, vendor, decrypted, existing) }.getOrNull()
                if (res != null) probed++ else skipped++
            }
            logger.info { "Embedding model sweep complete: $probed probed, $skipped skipped/failed" }
            completed = true
        } finally {
            // Only start the weekly cooldown when the sweep actually finished; a
            // crash leaves the short lease to expire so another instance retries.
            if (completed) embeddingModelCatalogRepository.markSweepComplete(SWEEP_COOLDOWN_MS)
        }
    }

    /** Sweep once at startup (if due), then weekly. Call from Application.module. */
    fun startWeeklyRefresh() {
        appScope.launch {
            while (true) {
                try {
                    refreshAll()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    logger.error(e) { "Embedding model sweep failed — retrying at next interval" }
                }
                delay(REFRESH_INTERVAL_MS)
            }
        }
    }

    private fun isStale(lastProbedAt: Instant?): Boolean =
        lastProbedAt == null || Duration.between(lastProbedAt, Instant.now()) >= STALE_AFTER
}
