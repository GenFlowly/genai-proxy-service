package com.genflowly.activity

import com.genflowly.Routes
import com.genflowly.aicallerlib.clients.AIClient
import com.genflowly.aicallerlib.models.*
import com.genflowly.aicallerlib.models.claude.*
import com.genflowly.aicallerlib.models.gemini.*
import com.genflowly.aicallerlib.models.openai.*
import com.genflowly.models.*
import com.genflowly.service.AIRequestService
import com.genflowly.utils.fetchApiKey
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.post
import org.slf4j.LoggerFactory
import service.CustomerProfileService

private val logger = LoggerFactory.getLogger("GetTextGenerationModelsRoute")

fun Route.registerGetTextGenerationModelsRoutes(
    aiRequestService: AIRequestService,
    customerProfileService: CustomerProfileService
) {

    authenticate("auth0") {
        post(Routes.GET_TEXT_GENERATION_MODELS) {
            val request = call.receive<GetTextGenerationModelsRequest>()

            val startTime = System.currentTimeMillis()

            val aiVendorModelList = request.aiVendor.map { vendor ->
                val vendorStart = System.currentTimeMillis()

                val apiKey = fetchApiKey(
                    vendor,
                    request.customerId,
                    customerProfileService
                )

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
                logger.info(
                    "AI response received: vendor={}, durationMs={}, response={}",
                    vendor, vendorDuration, modelsListResponse
                )

                AIVendorModelList(
                    aiVendor = vendor,
                    modelsList = modelsListResponse.toList()
                )
            }

            val durationMs = System.currentTimeMillis() - startTime
            logger.info(
                "Total AI models fetch completed: vendors={}, totalDurationMs={}",
                request.aiVendor, durationMs
            )

            val response = GetTextGenerationModelsResponse(
                aiVendorModelList = aiVendorModelList
            )

            call.respond(response)
        }
    }
}
