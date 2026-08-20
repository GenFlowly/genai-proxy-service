package com.genflowly.service

import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.models.api.AIVendorModelList
import io.ktor.client.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import models.aiVendorFromProviderString
import models.toProviderString
import org.slf4j.LoggerFactory

@Serializable
private data class ListModelsVendorCredentials(
    val provider: String,
    val api_key: String,
    val capability: String = "all"
)

@Serializable
private data class ListModelsPayload(
    val vendors: List<ListModelsVendorCredentials>
)

@Serializable
private data class VendorModels(
    val provider: String,
    val models: List<String>
)

@Serializable
private data class ListModelsResponse(
    val vendor_models: List<VendorModels>
)

@Serializable
private data class ValidateKeyPayload(
    val provider: String,
    val api_key: String
)

@Serializable
private data class ValidateKeyResponse(
    val provider: String,
    val valid: Boolean,
    val error: String? = null
)

class AIModelsService(
    private val customerProfileService: CustomerProfileService,
    private val httpClient: HttpClient,
    private val json: Json,
    private val retrievalServerUrl: String
) {
    private val logger = LoggerFactory.getLogger(AIModelsService::class.java)

    suspend fun getModelsForVendors(
        vendors: List<AIVendor>,
        customerId: String,
        capability: String = "all"
    ): List<AIVendorModelList> {
        val startTime = System.currentTimeMillis()

        val apiKeys: Map<AIVendor, String> = vendors.mapNotNull { vendor ->
            val apiKey = customerProfileService.getCustomerApiKeyForVendor(vendor, customerId)
            // If stored key is null, we can't fetch.
            if (apiKey == null) {
                logger.info("Skipping vendor {} as no API key is set.", vendor)
                null
            } else {
                vendor to apiKey
            }
        }.toMap()

        val fetchedModels = fetchModelsFromRetrievalServer(apiKeys, capability)

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
        val fetchedModels = fetchModelsFromRetrievalServer(mapOf(vendor to apiKey))
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
    suspend fun validateApiKey(
        vendor: AIVendor,
        apiKey: String
    ): Boolean {
        val payload = json.encodeToString(
            ValidateKeyPayload(
                provider = vendor.toProviderString(),
                api_key = apiKey
            )
        )
        return try {
            val response: HttpResponse = httpClient.post("$retrievalServerUrl/validate-key") {
                contentType(ContentType.Application.Json)
                setBody(payload)
            }
            if (!response.status.isSuccess()) {
                logger.warn("Retrieval server /validate-key returned {}", response.status)
                return false
            }
            val parsed = json.decodeFromString<ValidateKeyResponse>(response.bodyAsText())
            if (!parsed.valid) {
                logger.info("API key invalid for vendor {}: {}", vendor, parsed.error)
            }
            parsed.valid
        } catch (e: Exception) {
            logger.warn("Failed to validate API key for vendor {}: {}", vendor, e.message)
            false
        }
    }

    private suspend fun fetchModelsFromRetrievalServer(
        apiKeys: Map<AIVendor, String>,
        capability: String = "all"
    ): Map<AIVendor, List<String>> {
        if (apiKeys.isEmpty()) return emptyMap()

        val vendorStart = System.currentTimeMillis()
        val payload = json.encodeToString(
            ListModelsPayload(
                vendors = apiKeys.map { (vendor, apiKey) ->
                    ListModelsVendorCredentials(
                        provider = vendor.toProviderString(),
                        api_key = apiKey,
                        capability = capability
                    )
                }
            )
        )

        return try {
            val response: HttpResponse = httpClient.post("$retrievalServerUrl/models") {
                contentType(ContentType.Application.Json)
                setBody(payload)
            }
            if (!response.status.isSuccess()) {
                logger.warn(
                    "Retrieval server /models returned {}: {}",
                    response.status, response.bodyAsText()
                )
                return emptyMap()
            }

            val parsed = json.decodeFromString<ListModelsResponse>(response.bodyAsText())
            val durationMs = System.currentTimeMillis() - vendorStart
            logger.info(
                "Models fetched via retrieval server: durationMs={}, counts={}",
                durationMs, parsed.vendor_models.associate { it.provider to it.models.size }
            )

            parsed.vendor_models.mapNotNull { vendorModels ->
                aiVendorFromProviderString(vendorModels.provider)?.let { it to vendorModels.models }
            }.toMap()
        } catch (e: Exception) {
            logger.warn("Failed to fetch models from retrieval server: {}", e.message)
            emptyMap()
        }
    }
}
