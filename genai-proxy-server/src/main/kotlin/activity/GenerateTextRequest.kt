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


import io.ktor.server.routing.post
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import models.GenerateTextRequest
import models.GenerateTextResponse
import org.koin.ktor.ext.inject
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("GenerateTextRoute")

fun Route.registerGenerateTextRoutes() {
    val aiService by inject<AIRequestService>()

    post(Routes.GENERATE_TEXT) {
        val request = call.receive<GenerateTextRequest>()

        logger.info(
            "Received GenerateText request: vendor={}, model={}, promptLength={}",
            request.vendor, request.model, request.prompt.length
        )

        println("DEBUG prompt: ${request.prompt}")

        val apiKey = ""

        val aiRequest: AIRequest

        var aiResponse: AIResponse? = null

        val startTime = System.currentTimeMillis()

        when (request.vendor) {
            AIVendor.OPENAI -> {
                val responseCreateParams: ResponseCreateParams =
                    aiService.buildOpenAIRequest(request.prompt, request.model)
                val openAIProvider: AIClient<OpenAIResponse> =
                    aiService.getOpenAIProvider(apiKey)
                aiRequest = OpenAIRequest(responseCreateParams)
                aiResponse = openAIProvider.generateResponse(aiRequest)
            }

            AIVendor.GEMINI -> {
                val params: GenerateContentParameters =
                    aiService.buildGeminiRequest(
                        request
                            .prompt, request
                            .model
                    )

                val geminiProvider: AIClient<GeminiResponse> =
                    aiService.getGeminiProvider(apiKey)

                aiRequest = GeminiRequest(params)
                aiResponse = geminiProvider.generateResponse(aiRequest)
            }

            AIVendor.CLAUDE -> {
                val messageCreateParams: MessageCreateParams =
                    aiService.buildClaudeRequest(request.prompt, request.model)

                val claudeProvider: AIClient<ClaudeResponse> =
                    aiService.getClaudeProvider(apiKey)

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

        println("DEBUG response: ${response.text}")
        call.respond(response)
    }
}
