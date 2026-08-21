package com.genflowly.service

import com.genflowly.models.AIVendor
import com.genflowly.models.api.AIVendorModelList
import com.genflowly.providers.RetrievalServerClient
import org.slf4j.LoggerFactory

/**
 * Model discovery and API-key validation. Listing is catalog-based on the
 * retrieval-server side (LiteLLM catalog), so vendors are only queried for
 * key validation.
 */
class AIModelsService(
    private val customerCredentialsService: CustomerCredentialsService,
    private val retrievalServerClient: RetrievalServerClient
) {
    private val logger = LoggerFactory.getLogger(AIModelsService::class.java)

    suspend fun getModelsForVendors(
        vendors: List<AIVendor>,
        customerId: String,
        capability: String = "all"
    ): List<AIVendorModelList> {
        val startTime = System.currentTimeMillis()

        val apiKeys: Map<AIVendor, String> = vendors.mapNotNull { vendor ->
            val apiKey = customerCredentialsService.getCustomerApiKeyForVendor(vendor, customerId)
            // If stored key is null, we can't fetch.
            if (apiKey == null) {
                logger.info("Skipping vendor {} as no API key is set.", vendor)
                null
            } else {
                vendor to apiKey
            }
        }.toMap()

        val fetchedModels = retrievalServerClient.listModels(apiKeys, capability)

        val aiVendorModelList = vendors.map { vendor ->
            AIVendorModelList(
                aiVendor = vendor,
                modelsList = fetchedModels[vendor].orEmpty()
            )
        }

        val durationMs = System.currentTimeMillis() - startTime
        logger.info(
            "Total AI models fetch completed: vendors={}, totalDurationMs={}",
            vendors, durationMs
        )

        return aiVendorModelList
    }

    suspend fun getModelsWithApiKey(
        vendor: AIVendor,
        apiKey: String
    ): AIVendorModelList {
        val fetchedModels = retrievalServerClient.listModels(mapOf(vendor to apiKey))
        return AIVendorModelList(
            aiVendor = vendor,
            modelsList = fetchedModels[vendor].orEmpty()
        )
    }

    /**
     * Check a vendor API key with one cheap authenticated vendor call.
     * Model listing is catalog-based and does not touch the vendor, so it
     * can no longer serve as implicit key validation.
     */
    suspend fun validateApiKey(vendor: AIVendor, apiKey: String): Boolean =
        retrievalServerClient.validateApiKey(vendor, apiKey)
}
