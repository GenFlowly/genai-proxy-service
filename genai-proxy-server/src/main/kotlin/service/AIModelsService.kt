package com.genflowly.service

import com.genflowly.aicallerlib.clients.AIClient
import com.genflowly.aicallerlib.models.*
import com.genflowly.aicallerlib.models.claude.*
import com.genflowly.aicallerlib.models.gemini.*
import com.genflowly.aicallerlib.models.openai.*
import com.genflowly.models.api.AIVendorModelList
import com.genflowly.utils.fetchApiKey
import org.slf4j.LoggerFactory

class AIModelsService(
    private val aiRequestService: AIRequestService,
    private val customerProfileService: CustomerProfileService
) {
    private val logger = LoggerFactory.getLogger(AIModelsService::class.java)

    suspend fun getModelsForVendors(
        vendors: List<AIVendor>,
        customerId: String
    ): List<AIVendorModelList> {
        val startTime = System.currentTimeMillis()

        val aiVendorModelList = vendors.map { vendor ->
            getModelsForVendor(vendor, customerId)
        }

        val durationMs = System.currentTimeMillis() - startTime
        logger.info(
            "Total AI models fetch completed: vendors={}, totalDurationMs={}",
            vendors, durationMs
        )

        return aiVendorModelList
    }

    private suspend fun getModelsForVendor(
        vendor: AIVendor,
        customerId: String
    ): AIVendorModelList {
        val apiKey = fetchApiKey(
            vendor,
            customerId,
            customerProfileService
        )
        // If stored key is null, we can't fetch.
        if (apiKey == null) {
            logger.info("Skipping vendor {} as no API key is set.", vendor)
            return AIVendorModelList(
                aiVendor = vendor,
                modelsList = emptyList()
            )
        }
        return getModelsWithApiKey(vendor, apiKey)
    }

    suspend fun getModelsWithApiKey(
        vendor: AIVendor,
        apiKey: String
    ): AIVendorModelList {
        val vendorStart = System.currentTimeMillis()

        try {
            val modelsListResponse: AIModelsListResponse = when (vendor) {
                AIVendor.OPENAI -> {
                    val openAIProvider: AIClient<OpenAIResponse, OpenAIModelsListResponse> =
                        aiRequestService.getOpenAIProvider(apiKey)
                    openAIProvider.listTextGenerationModels()
                }

                AIVendor.GEMINI -> {
                    val geminiProvider: AIClient<GeminiResponse, GeminiModelsListResponse> =
                        aiRequestService.getGeminiProvider(apiKey)
                    geminiProvider.listTextGenerationModels()
                }

                AIVendor.CLAUDE -> {
                    val claudeProvider: AIClient<ClaudeResponse, ClaudeModelsListResponse> =
                        aiRequestService.getClaudeProvider(apiKey)
                    claudeProvider.listTextGenerationModels()
                }
            }

            val vendorDuration = System.currentTimeMillis() - vendorStart
            val modelCount = modelsListResponse.toList().size
            logger.info(
                "AI response received: vendor={}, durationMs={}, modelCount={}",
                vendor, vendorDuration, modelCount
            )

            return AIVendorModelList(
                aiVendor = vendor,
                modelsList = modelsListResponse.toList()
            )
        } catch (e: Exception) {
            logger.warn("Failed to fetch models for vendor {}: {}", vendor, e.message)
            // Return empty list on failure (e.g., invalid key)
            return AIVendorModelList(
                aiVendor = vendor,
                modelsList = emptyList()
            )
        }
    }
}
