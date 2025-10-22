package com.genflowly.activity

import com.anthropic.models.messages.MessageCreateParams
import com.genflowly.Routes
import com.genflowly.aicallerlib.clients.AIClient
import com.genflowly.aicallerlib.models.AIRequest
import com.genflowly.aicallerlib.models.AIResponse
import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.aicallerlib.models.claude.ClaudeRequest
import com.genflowly.aicallerlib.models.claude.ClaudeResponse
import com.genflowly.aicallerlib.models.gemini.GeminiRequest
import com.genflowly.aicallerlib.models.gemini.GeminiResponse
import com.genflowly.aicallerlib.models.openai.OpenAIRequest
import com.genflowly.aicallerlib.models.openai.OpenAIResponse
import com.genflowly.service.AIRequestService
import com.google.genai.types.GenerateContentParameters
import com.openai.models.responses.ResponseCreateParams
import io.ktor.server.auth.authenticate


import io.ktor.server.routing.post
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import models.GenerateTextRequest
import models.GenerateTextResponse
import org.slf4j.LoggerFactory
import service.CustomerProfileService

private val logger = LoggerFactory.getLogger("GenerateTextRoute")

fun Route.registerGenerateTextRoutes(
    aiRequestService: AIRequestService,
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0") {
        post(Routes.GENERATE_TEXT) {
            val request = call.receive<GenerateTextRequest>()

            logger.info(
                "Received GenerateText request: vendor={}, model={}, promptLength={}",
                request.vendor, request.model, request.prompt.length
            )

            val aiRequest: AIRequest

            var aiResponse: AIResponse? = null

            val startTime = System.currentTimeMillis()

            when (request.vendor) {
                AIVendor.OPENAI -> {
                    val responseCreateParams: ResponseCreateParams =
                        aiRequestService.buildOpenAIRequest(
                            request.prompt,
                            request.model
                        )
                    val apiKey =
                        fetchApiKey(
                            AIVendor.OPENAI,
                            request.customerId,
                            customerProfileService
                        )
                    val openAIProvider: AIClient<OpenAIResponse> =
                        aiRequestService.getOpenAIProvider(apiKey)
                    aiRequest = OpenAIRequest(responseCreateParams)
                    aiResponse = openAIProvider.generateResponse(aiRequest)
                }

                AIVendor.GEMINI -> {
                    val params: GenerateContentParameters =
                        aiRequestService.buildGeminiRequest(
                            request.prompt,
                            request.model
                        )

                    val apiKey =
                        fetchApiKey(
                            AIVendor.GEMINI,
                            request.customerId,
                            customerProfileService
                        )
                    val geminiProvider: AIClient<GeminiResponse> =
                        aiRequestService.getGeminiProvider(apiKey)

                    aiRequest = GeminiRequest(params)
                    aiResponse = geminiProvider.generateResponse(aiRequest)
                }

                AIVendor.CLAUDE -> {
                    val messageCreateParams: MessageCreateParams =
                        aiRequestService.buildClaudeRequest(
                            request.prompt,
                            request.model
                        )
                    val apiKey =
                        fetchApiKey(
                            AIVendor.CLAUDE,
                            request.customerId,
                            customerProfileService
                        )
                    val claudeProvider: AIClient<ClaudeResponse> =
                        aiRequestService.getClaudeProvider(apiKey)

                    aiRequest = ClaudeRequest(messageCreateParams)
                    aiResponse = claudeProvider.generateResponse(aiRequest)
                }
            }


            val response = GenerateTextResponse(
                text = aiResponse.getText()
            )

            val durationMs = System.currentTimeMillis() - startTime

            logger.info(
                "AI response received: vendor={}, model={}, durationMs={}, response={}",
                request.vendor, request.model, durationMs, response.text
            )

            call.respond(response)
        }
    }
}

private fun fetchApiKey(
    aiVendor: AIVendor,
    customerId: String,
    customerProfileService: CustomerProfileService
): String {
    return customerProfileService.getCustomerApiKeyForVendor(
        aiVendor,
        customerId
    )
}
