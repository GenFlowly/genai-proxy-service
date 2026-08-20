package com.genflowly.service

import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.repository.ModelCatalogRepository
import com.genflowly.providers.RetrievalServerClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import models.ModelCatalogEntry
import mu.KotlinLogging
import java.util.concurrent.ConcurrentHashMap

private val logger = KotlinLogging.logger {}

/**
 * Keeps the AIModelCatalog DDB table in sync with the vendors' model APIs and
 * answers "what is this model's real output-token cap?" at request time.
 *
 * Refresh path (daily + on startup): for every vendor with a system API key,
 * ask the retrieval-server's /models/metadata endpoint (which calls the
 * vendor's own model-listing API) and upsert the per-model token limits into
 * DDB. Lookup path (hot): in-memory cache -> DDB GetItem, with negative
 * caching so unknown models don't hit DDB on every request.
 */
class ModelCatalogService(
    private val systemApiKeyService: SystemApiKeyService,
    private val modelCatalogRepository: ModelCatalogRepository,
    private val retrievalServerClient: RetrievalServerClient
) {
    companion object {
        /** Used when the catalog has no entry for a model — safe across all vendors. */
        const val FALLBACK_MAX_TOKENS = 4096

        /**
         * Ceilings applied to the model's cap when the caller didn't ask for a
         * specific budget. Non-streaming requests risk vendor/HTTP timeouts on
         * very long generations, so they get a tighter ceiling.
         */
        const val STREAMING_DEFAULT_CEILING = 64_000
        const val NON_STREAMING_DEFAULT_CEILING = 16_384

        private const val CACHE_TTL_MS = 6 * 60 * 60 * 1000L
        private const val REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000L
    }

    private data class CacheEntry(val entry: ModelCatalogEntry?, val fetchedAt: Long)

    // Key "<vendor>#<model>"; a null entry is a cached "not in catalog"
    private val cache = ConcurrentHashMap<String, CacheEntry>()

    /** Refresh once at startup, then daily. Call from Application.module. */
    fun startDailyRefresh(scope: CoroutineScope) {
        scope.launch {
            while (true) {
                try {
                    refreshCatalog()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    logger.error(e) { "Model catalog refresh failed — retrying at next interval" }
                }
                delay(REFRESH_INTERVAL_MS)
            }
        }
    }

    /**
     * Fetches per-model metadata for every vendor that has a system API key
     * and upserts it into the AIModelCatalog table.
     * Returns models-stored count per vendor.
     */
    suspend fun refreshCatalog(): Map<String, Int> {
        val vendorKeys = AIVendor.entries.mapNotNull { vendor ->
            systemApiKeyService.getSystemApiKeyForVendor(vendor)?.let { vendor to it }
        }
        if (vendorKeys.isEmpty()) {
            logger.warn { "Model catalog refresh skipped: no system API keys configured" }
            return emptyMap()
        }

        val counts = mutableMapOf<String, Int>()
        for (vendorMetadata in retrievalServerClient.fetchModelMetadata(vendorKeys)) {
            val vendor = vendorMetadata.vendor
            if (vendorMetadata.error != null) {
                logger.warn {
                    "Model metadata fetch failed for ${vendor.name}: ${vendorMetadata.error} — keeping existing catalog rows"
                }
                continue
            }
            val entries = vendorMetadata.models
            if (entries.isEmpty()) continue
            modelCatalogRepository.saveModelCatalogEntries(vendor.name, entries)
            entries.forEach { entry ->
                cache[cacheKey(vendor, entry.model)] =
                    CacheEntry(entry, System.currentTimeMillis())
            }
            counts[vendor.name] = entries.size
        }
        logger.info { "Model catalog refreshed: $counts" }
        return counts
    }

    /**
     * The catalog row for a model (limits + pricing), or null when unknown.
     * Serves from the in-memory cache, falling back to a DDB GetItem.
     */
    suspend fun getCatalogEntry(vendor: AIVendor, model: String): ModelCatalogEntry? {
        val key = cacheKey(vendor, model)
        val cached = cache[key]
        if (cached != null && System.currentTimeMillis() - cached.fetchedAt < CACHE_TTL_MS) {
            return cached.entry
        }
        val entry = try {
            modelCatalogRepository.getModelCatalogEntry(vendor.name, model)
        } catch (e: Exception) {
            logger.warn(e) { "Model catalog lookup failed for ${vendor.name}/$model" }
            // Don't poison the negative cache on transient DDB errors
            return cached?.entry
        }
        cache[key] = CacheEntry(entry, System.currentTimeMillis())
        return entry
    }

    /** The model's output-token cap from the catalog, or null when unknown. */
    suspend fun getMaxOutputTokens(vendor: AIVendor, model: String): Int? =
        getCatalogEntry(vendor, model)?.maxOutputTokens

    /**
     * The max_tokens value to send to the vendor for this request.
     *
     * - Explicit [requested] budgets are honored but clamped to the model's
     *   real cap so oversized requests don't 400 at the vendor.
     * - Without a request, the model's cap is used, bounded by a
     *   streaming/non-streaming ceiling (very long non-streaming generations
     *   risk HTTP timeouts).
     * - Unknown models fall back to [FALLBACK_MAX_TOKENS].
     */
    suspend fun resolveMaxTokens(
        vendor: AIVendor,
        model: String,
        requested: Int?,
        streaming: Boolean
    ): Int {
        val cap = getMaxOutputTokens(vendor, model)
        val resolved = when {
            requested != null -> cap?.coerceAtMost(requested) ?: requested
            cap != null -> cap.coerceAtMost(
                if (streaming) STREAMING_DEFAULT_CEILING else NON_STREAMING_DEFAULT_CEILING
            )
            else -> FALLBACK_MAX_TOKENS
        }
        logger.debug {
            "Resolved maxTokens for ${vendor.name}/$model: requested=$requested cap=$cap streaming=$streaming -> $resolved"
        }
        return resolved
    }

    private fun cacheKey(vendor: AIVendor, model: String) = "${vendor.name}#$model"
}
