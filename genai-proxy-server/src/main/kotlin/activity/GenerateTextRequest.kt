package com.genflowly.activity

import com.anthropic.models.messages.MessageCreateParams
import com.genflowly.Routes
import com.genflowly.aicallerlib.clients.AIProvider
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

fun Route.registerGenerateTextRoutes() {
    post(Routes.GENERATE_TEXT) {
        val request = call.receive<GenerateTextRequest>()

        val aiService = AIRequestService()

        val aiRequest: AIRequest

        var aiResponse: AIResponse? = null

        when(request.vendor) {
            AIVendor.OPENAI -> {
                val responseCreateParams: ResponseCreateParams =
                    aiService.buildOpenAIRequest(request.prompt, request.model)
                val openAIProvider: AIProvider<OpenAIResponse> = aiService.getOpenAIProvider()
                aiRequest = OpenAIRequest(responseCreateParams)
                aiResponse = openAIProvider.generateResponse(aiRequest)
            }
            AIVendor.GEMINI -> {
                val params: GenerateContentParameters = aiService.buildGeminiRequest(request
                    .prompt, request
                    .model)
                val geminiProvider: AIProvider<GeminiResponse> = aiService.getGeminiProvider()
                aiRequest = GeminiRequest(params)
                aiResponse = geminiProvider.generateResponse(aiRequest)
            }
            AIVendor.CLAUDE -> {
                val messageCreateParams: MessageCreateParams = aiService.buildClaudeRequest(request.prompt, request.model)
                val claudeProvider: AIProvider<ClaudeResponse> = aiService.getClaudeProvider()
                aiRequest = ClaudeRequest(messageCreateParams)
                aiResponse = claudeProvider.generateResponse(aiRequest)
            }
        }


        val response = GenerateTextResponse(
            text = aiResponse.getText()
        )
        call.respond(response)
    }
}
