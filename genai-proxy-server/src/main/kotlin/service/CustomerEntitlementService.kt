package com.genflowly.service

import com.genflowly.DynamoDBConstants.AI_VENDOR_KEY
import com.genflowly.models.CustomerEntitlements
import com.genflowly.models.EmbeddingVendor
import com.genflowly.providers.SearchNotConfiguredException
import com.genflowly.providers.SearchSetupReason
import com.genflowly.repository.CustomerCredentialsRepository
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.EmbeddingModelCatalogRepository
import kotlinx.coroutines.CancellationException
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

/**
 * CustomerToolCredentials sort key of the web search key. The Settings >
 * Tools card saves it under this name and the retrieval-server's web_search
 * tool reads it.
 */
private const val WEB_SEARCH_TOOL_TYPE = "WEB_SEARCH"

/**
 * Keeps each customer's entitlement flags in step with their stored
 * credentials and answers what the flags allow. [refresh] runs after every
 * credential change. Features read [get] and fail fast when a flag is off, so
 * no text is sent to be embedded or stored when it has nowhere to go.
 */
class CustomerEntitlementService(
    private val customerProfileRepository: CustomerProfileRepository,
    private val customerCredentialsRepository: CustomerCredentialsRepository,
    private val embeddingModelCatalogRepository: EmbeddingModelCatalogRepository,
) {

    /**
     * The customer's entitlements. A profile saved before the flags existed
     * gets them derived from its credentials and stored on first read.
     */
    suspend fun get(customerId: String): CustomerEntitlements =
        customerProfileRepository.getEntitlements(customerId) ?: refresh(customerId)

    /**
     * [get], or null when the flags can't be read. Callers then behave as if
     * the flags didn't exist: a failed read must not switch a feature off.
     */
    suspend fun getOrNull(customerId: String): CustomerEntitlements? = try {
        get(customerId)
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        logger.warn { "Could not read entitlements for $customerId: ${e.message}" }
        null
    }

    /** Re-derives the customer's flags from their stored credentials and saves them. */
    suspend fun refresh(customerId: String): CustomerEntitlements {
        val entitlements = CustomerEntitlements(
            isVectorDbStoringEnabled = customerCredentialsRepository.hasVectorDBConfig(customerId),
            isEmbeddingCreationEnabled = hasEmbeddingKey(customerId),
            isWebSearchEnabled = hasWebSearchKey(customerId),
        )
        customerProfileRepository.saveEntitlements(customerId, entitlements)
        return entitlements
    }

    /**
     * Throws [SearchNotConfiguredException] when semantic search can't run for
     * the customer: the answer the retrieval-server would give, without the
     * round trip. Flags that can't be read let the search run.
     */
    suspend fun requireSearchable(customerId: String) {
        val entitlements = getOrNull(customerId) ?: return
        if (!entitlements.isVectorDbStoringEnabled) {
            throw SearchNotConfiguredException(SearchSetupReason.VECTOR_DB, "Connect a vector database to search.")
        }
        if (!entitlements.isEmbeddingCreationEnabled) {
            throw SearchNotConfiguredException(SearchSetupReason.EMBEDDING_KEY, "Add an embedding provider key to search.")
        }
    }

    /**
     * A stored key for a vendor that embeds (the OPENAI row doubles as the
     * chat key), valid, and not rejected by the embedding probe. The
     * HUGGINGFACE token only downloads tokenizers, so it never counts.
     */
    private suspend fun hasEmbeddingKey(customerId: String): Boolean {
        val itemsByVendor = customerCredentialsRepository.getCustomerVendorItems(customerId)
            .associateBy { it[AI_VENDOR_KEY]?.s() }
        return EmbeddingVendor.entries.filter { it.embeds }.any { vendor ->
            val item = itemsByVendor[vendor.name] ?: return@any false
            // Legacy items may lack the validity flag: a stored key counts as valid.
            !item["apiKey"]?.s().isNullOrBlank() && item["isAPIKeyValid"]?.bool() != false &&
                !probeRejected(customerId, vendor)
        }
    }

    private suspend fun probeRejected(customerId: String, vendor: EmbeddingVendor): Boolean =
        runCatching { embeddingModelCatalogRepository.getProbed(customerId, vendor.name) }
            .getOrNull()?.authFailed == true

    private suspend fun hasWebSearchKey(customerId: String): Boolean =
        !customerCredentialsRepository.getCustomerToolCredentials(customerId, WEB_SEARCH_TOOL_TYPE)
            ?.get("credentials")?.s().isNullOrBlank()
}
