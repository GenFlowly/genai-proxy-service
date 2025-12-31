package com.genflowly.service

import com.anthropic.models.messages.MessageCreateParams
import com.anthropic.models.messages.MessageParam
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
import com.openai.models.responses.ResponseInputItem
import com.openai.models.responses.ResponseCreateParams.Input
import models.Message
import org.koin.core.component.KoinComponent
import org.koin.core.parameter.parametersOf
import org.koin.core.qualifier.named
import org.koin.java.KoinJavaComponent.get

class AIRequestService(private val dynamoDBProvider: DynamoDBProvider) :
    KoinComponent {

    fun buildClaudeRequest(
        messages: List<Message>,
        model: String,
        systemPrompt: String
    ): MessageCreateParams {
        val messageParams = messages.map { msg ->
            MessageParam.builder()
                .role(MessageParam.Role.of(msg.role))
                .content(msg.text)
                .build()
        }

        return MessageCreateParams.builder()
            .system(systemPrompt)
            .maxTokens(4096L)
            .model(model)
            .messages(messageParams)
            .build()
    }

    fun getClaudeProvider(apiKey: String): AIClient<ClaudeResponse, ClaudeModelsListResponse> {
        return get(
            AIClient::class.java,
            named(AIVendor.CLAUDE)
        ) { parametersOf(apiKey) }
    }

    fun buildOpenAIRequest(
        messages: List<Message>,
        model: String,
        systemPrompt: String
    ): ResponseCreateParams {
        val inputItems = messages.map { msg ->
             val role = if (msg.role.equals("assistant", ignoreCase = true)) {
                 ResponseInputItem.Message.Role.of("assistant")
             } else {
                 ResponseInputItem.Message.Role.of("user")
             }
             
             ResponseInputItem.ofMessage(
                 ResponseInputItem.Message.builder()
                     .role(role)
                     .addInputTextContent(msg.text)
                     .build()
             )
        }

        return ResponseCreateParams.builder()
            .instructions(systemPrompt)
            .input(Input.ofResponse(inputItems))
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
        messages: List<Message>,
        model: String,
        systemPrompt: String
    ): GenerateContentParameters {
        val systemInstruction = Content.builder()
            .role("system") // Role is "system" for instructions
            .parts(
                Part.builder()
                    .text(systemPrompt)
                    .build()
            )
            .build()

        val mappedContents = messages.map { msg ->
             val geminiRole = if (msg.role == "assistant") "model" else "user"
             Content.builder()
                .role(geminiRole)
                .parts(Part.builder().text(msg.text).build())
                .build()
        }

        val config = GenerateContentConfig.builder()
            .systemInstruction(systemInstruction)
            .build()

        return GenerateContentParameters.builder()
            .model(model)
            .config(config)
            .contents(mappedContents)
            .build()
    }

    fun getGeminiProvider(apiKey: String): AIClient<GeminiResponse, GeminiModelsListResponse> {
        return get(
            AIClient::class.java,
            named(AIVendor.GEMINI)
        ) { parametersOf(apiKey) }
    }


}