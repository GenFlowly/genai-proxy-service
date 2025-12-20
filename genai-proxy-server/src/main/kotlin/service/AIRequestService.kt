package com.genflowly.service

import com.anthropic.models.messages.MessageCreateParams
import com.genflowly.aicallerlib.clients.AIClient
import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.aicallerlib.models.claude.ClaudeModelsListResponse
import com.genflowly.aicallerlib.models.claude.ClaudeResponse
import com.genflowly.aicallerlib.models.gemini.GeminiModelsListResponse
import com.genflowly.aicallerlib.models.gemini.GeminiResponse
import com.genflowly.aicallerlib.models.openai.OpenAIModelsListResponse
import com.genflowly.aicallerlib.models.openai.OpenAIResponse
import com.genflowly.providers.DynamoDBProvider
import com.google.genai.types.Content
import com.google.genai.types.GenerateContentConfig
import com.google.genai.types.GenerateContentParameters
import com.google.genai.types.Part
import com.openai.models.responses.ResponseCreateParams
import org.koin.core.component.KoinComponent
import org.koin.core.parameter.parametersOf
import org.koin.core.qualifier.named
import org.koin.java.KoinJavaComponent.get

class AIRequestService(private val dynamoDBProvider: DynamoDBProvider) :
    KoinComponent {

    fun buildClaudeRequest(
        prompt: String,
        model: String,
        systemPrompt: String
    ):
            MessageCreateParams {
        return MessageCreateParams.builder()
            .system(systemPrompt)
            .maxTokens(1024L)
            .addUserMessage(prompt)
            .model(model)
            .build()
    }

    fun getClaudeProvider(apiKey: String): AIClient<ClaudeResponse, ClaudeModelsListResponse> {
        return get(
            AIClient::class.java,
            named(AIVendor.CLAUDE)
        ) { parametersOf(apiKey) }
    }

    fun buildOpenAIRequest(
        prompt: String,
        model: String,
        systemPrompt: String
    ): ResponseCreateParams {
        return ResponseCreateParams.builder()
            .instructions(systemPrompt)
            .input(prompt)
            .model(model)
            .build()
    }

    fun getOpenAIProvider(apiKey: String): AIClient<OpenAIResponse, OpenAIModelsListResponse> {
        return get(
            AIClient::class.java,
            named(AIVendor.OPENAI)
        ) { parametersOf(apiKey) }
    }

    fun buildGeminiRequest(
        prompt: String,
        model: String,
        systemPrompt: String
    ): GenerateContentParameters {
        val systemInstruction = Content.builder()
            .role("system") // Role is "system" for instructions
            .parts(
                Part.builder()
                    .text("systemPrompt")
                    .build()
            )
            .build()

        val content = Content.builder()
            .role("user")
            .parts(
                Part.builder()
                    .text(prompt)
                    .build()
            )
            .build()

        val config = GenerateContentConfig.builder()
            .systemInstruction(systemInstruction)
            .build()

        return GenerateContentParameters.builder()
            .model(model)
            .config(config)
            .contents(content)
            .build()
    }

    fun getGeminiProvider(apiKey: String): AIClient<GeminiResponse, GeminiModelsListResponse> {
        return get(
            AIClient::class.java,
            named(AIVendor.GEMINI)
        ) { parametersOf(apiKey) }
    }


}