package com.genflowly.service

import com.anthropic.models.messages.CacheControlEphemeral
import com.anthropic.models.messages.ContentBlockParam
import com.anthropic.models.messages.MessageCreateParams
import com.anthropic.models.messages.MessageParam
import com.anthropic.models.messages.TextBlockParam
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
import com.openai.core.JsonValue
import com.openai.models.responses.ResponseInputText
import com.openai.models.responses.ResponseInputContent
import com.openai.models.responses.ResponseInputItem
import com.openai.models.responses.ResponseCreateParams.Input
import java.time.Duration
import models.Message
import org.koin.core.component.KoinComponent
import org.koin.core.parameter.parametersOf
import org.koin.core.qualifier.named
import org.koin.java.KoinJavaComponent.get
import org.slf4j.LoggerFactory

class AIRequestService(private val dynamoDBProvider: DynamoDBProvider) :
    KoinComponent {
    private val logger = LoggerFactory.getLogger("AIRequestService")

    fun buildClaudeRequest(
        messages: List<Message>,
        model: String,
        systemPrompt: String
    ): MessageCreateParams {
        val messageParams = messages.mapIndexed { index, msg ->
            val role = MessageParam.Role.of(msg.role)
            return@mapIndexed if (index == messages.lastIndex) {
                MessageParam.builder()
                    .role(role)
                    .content(
                        MessageParam.Content.ofBlockParams(
                            listOf(
                                ContentBlockParam.ofText(
                                    TextBlockParam.builder()
                                        .text(msg.text)
                                        .cacheControl(CacheControlEphemeral.builder().build())
                                        .build()
                                )
                            )
                        )
                    )
                    .build()
            } else {
                MessageParam.builder()
                    .role(role)
                    .content(msg.text)
                    .build()
            }
        }


        logger.debug("Sending request to CLAUDE - {}", messageParams)

        return MessageCreateParams.builder()
            .system(
                MessageCreateParams.System.ofTextBlockParams(
                    listOf(
                        TextBlockParam.builder()
                            .text(systemPrompt)
                            .cacheControl(
                                CacheControlEphemeral.builder()
                                    .build()
                            )
                            .build()
                    )
                )
            )
            .maxTokens(16384L)
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
             
             val builder = ResponseInputItem.Message.builder()
                 .role(role)

             if (msg.role.equals("assistant", ignoreCase = true)) {
                 // Manually construct output_text type using ResponseInputText builder
                 // as ResponseOutputText class is missing in this SDK version
                 val outputContent = ResponseInputText.builder()
                     .text(msg.text)
                     .type(JsonValue.from("output_text"))
                     .build()

                 builder.addContent(ResponseInputContent.ofInputText(outputContent))
             } else {
                 builder.addInputTextContent(msg.text)
             }
             
             ResponseInputItem.ofMessage(builder.build())
         }

        logger.info("Sending request to OPENAI - {}", inputItems)

        // Set conversationId as prompt cache key
        val promptCacheKey: String = messages[0].conversationId
        logger.info("Prompt Cache Key {}", promptCacheKey)

        return ResponseCreateParams.builder()
            .instructions(systemPrompt)
            .input(Input.ofResponse(inputItems))
            .model(model)
            .promptCacheKey(promptCacheKey)
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
            .parts(listOf(Part.builder().text(systemPrompt).build()))
            .build()

        // Usage of "model" role in direct content list may be filtered by some clients or API versions
        // if not using the stateful ChatSession. To ensure context is preserved, we collapse history
        // into a single "User" prompt if we suspect context loss.
        /*
        val fullPrompt = StringBuilder()
        messages.forEach { msg ->
             val prefix = if (msg.role == "assistant") "Model: " else "User: "
             fullPrompt.append("$prefix${msg.text}\n")
        }

        val mappedContents = listOf(
            Content.builder()
                .role("user")
                .parts(Part.builder().text(fullPrompt.toString()).build())
                .build()
        )
        */

        // 2. Map the conversation history
        val mappedContents = messages
            .filter { it.role.lowercase() != "system" }
            .map { msg ->
                val role = if (msg.role.equals("assistant", ignoreCase = true)) "model" else "user"
                Content.builder()
                    .role(role)
                    .parts(listOf(Part.builder().text(msg.text).build()))
                    .build()
            }

        logger.info("Sending request to GEMINI - $mappedContents")

        // 3. Build the Config containing the instructions
        val config = com.google.genai.types.GenerateContentConfig.builder()
            .systemInstruction(systemInstruction)
            .build()

        // 4. Return the parameters
        return GenerateContentParameters.builder()
            .model(model)
            .contents(mappedContents)
            .config(config)
            .build()
    }

    fun getGeminiProvider(apiKey: String): AIClient<GeminiResponse, GeminiModelsListResponse> {
        return get(
            AIClient::class.java,
            named(AIVendor.GEMINI)
        ) { parametersOf(apiKey) }
    }


}