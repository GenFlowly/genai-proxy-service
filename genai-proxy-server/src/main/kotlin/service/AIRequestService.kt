package com.genflowly.service

import com.anthropic.models.messages.MessageCreateParams
import com.genflowly.aicallerlib.AIProviderFactory
import com.genflowly.aicallerlib.clients.AIProvider
import com.genflowly.aicallerlib.models.AIRequest
import com.genflowly.aicallerlib.models.AIResponse
import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.aicallerlib.models.claude.ClaudeResponse
import com.genflowly.aicallerlib.models.gemini.GeminiResponse
import com.genflowly.aicallerlib.models.openai.OpenAIResponse
import com.google.genai.types.Content
import com.google.genai.types.GenerateContentParameters
import com.google.genai.types.Part
import com.openai.models.ChatModel
import com.openai.models.responses.ResponseCreateParams

class AIRequestService(private val aiProviderFactory: AIProviderFactory = AIProviderFactory()) {

    fun buildClaudeRequest(prompt: String, model: String): MessageCreateParams {
        return MessageCreateParams.builder()
            .maxTokens(1024L)
            .addUserMessage(prompt)
            .model(model)
            .build()
    }

    fun getClaudeProvider(): AIProvider<ClaudeResponse> {
        return aiProviderFactory.getProvider(AIVendor.CLAUDE)
    }

    fun buildOpenAIRequest(prompt: String, model: String): ResponseCreateParams {
        return ResponseCreateParams.builder()
            .input(prompt)
            .model(model)
            .build()
    }

    fun getOpenAIProvider(): AIProvider<OpenAIResponse> {
        return aiProviderFactory.getProvider(AIVendor.OPENAI)
    }

    fun buildGeminiRequest(prompt: String, model: String): GenerateContentParameters {
        val content = Content.builder()
            .role("user")
            .parts(
                Part.builder()
                    .text(prompt)
                    .build()
            )
            .build()

        return GenerateContentParameters.builder()
            .model(model)
            .contents(content)
            .build()
    }

    fun getGeminiProvider(): AIProvider<GeminiResponse> {
        return aiProviderFactory.getProvider(AIVendor.GEMINI)
    }

}