package com.genflowly.activity

import com.genflowly.Routes
import com.genflowly.aicallerlib.clients.AIClient
import com.genflowly.aicallerlib.models.AIModelsListResponse
import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.aicallerlib.models.claude.ClaudeModelsListResponse
import com.genflowly.aicallerlib.models.claude.ClaudeResponse
import com.genflowly.aicallerlib.models.gemini.GeminiModelsListResponse
import com.genflowly.aicallerlib.models.gemini.GeminiResponse
import com.genflowly.aicallerlib.models.openai.OpenAIModelsListResponse
import com.genflowly.aicallerlib.models.openai.OpenAIResponse
import com.genflowly.models.GetTextGenerationModelsRequest
import com.genflowly.models.GetTextGenerationModelsResponse
import com.genflowly.service.AIRequestService
import com.genflowly.utils.fetchApiKey
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.routing.Route
import io.ktor.server.routing.post
import org.slf4j.LoggerFactory
import service.CustomerProfileService
import io.ktor.server.response.respond

private val logger = LoggerFactory.getLogger("GetTextGenerationModelsRoute")

fun Route.registerGetTextGenerationModelsRoutes(
    aiRequestService: AIRequestService,
    customerProfileService: CustomerProfileService
) {

    authenticate("auth0") {
        post(Routes.GET_TEXT_GENERATION_MODELS) {
            val request = call.receive<GetTextGenerationModelsRequest>()

            val modelsListResponse: AIModelsListResponse

            val startTime = System.currentTimeMillis()

            when (request.aiVendor) {
                AIVendor.OPENAI -> {
                    val apiKey =
                        fetchApiKey(
                            AIVendor.OPENAI,
                            request.customerId,
                            customerProfileService
                        )

                    val openAIProvider: AIClient<OpenAIResponse, OpenAIModelsListResponse> =
                        aiRequestService.getOpenAIProvider(apiKey)

                    modelsListResponse =
                        openAIProvider.listTextGenerationModels()
                }

                AIVendor.GEMINI -> {

                    val apiKey =
                        fetchApiKey(
                            AIVendor.GEMINI,
                            request.customerId,
                            customerProfileService
                        )

                    val geminiProvider: AIClient<GeminiResponse,
                            GeminiModelsListResponse> =
                        aiRequestService.getGeminiProvider(apiKey)

                    modelsListResponse =
                        geminiProvider.listTextGenerationModels()

                }

                AIVendor.CLAUDE -> {

                    val apiKey =
                        fetchApiKey(
                            AIVendor.CLAUDE,
                            request.customerId,
                            customerProfileService
                        )

                    val claudeProvider: AIClient<ClaudeResponse,
                            ClaudeModelsListResponse> =
                        aiRequestService.getClaudeProvider(apiKey)


                    modelsListResponse =
                        claudeProvider.listTextGenerationModels()

                }
            }

            val durationMs = System.currentTimeMillis() - startTime

            logger.info(
                "AI response received: vendor={}, durationMs={}, " +
                        "response={}",
                request.aiVendor, durationMs, modelsListResponse
            )

            val response = GetTextGenerationModelsResponse(
                aiVendor = request.aiVendor,
                modelsList = modelsListResponse.toList()
            )

            call.respond(response)
        }
    }

}