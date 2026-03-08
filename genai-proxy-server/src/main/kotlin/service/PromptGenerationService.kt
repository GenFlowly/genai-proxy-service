package com.genflowly.service

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.slf4j.LoggerFactory

class PromptGenerationService(
    private val retrievalService: RetrievalService
) {
    private val logger = LoggerFactory.getLogger("PromptGenerationService")
    private val json = Json { ignoreUnknownKeys = true }

    suspend fun generatePrompt(customerId: String, userRequestRawPrompt: String, systemPrompt: String?): String {
        val vectorResponse = retrievalService.retrieveContext(customerId, userRequestRawPrompt, "")

        if (vectorResponse == null) {
            logger.warn("Retrieval Service returned null or failed for customer $customerId")
            return userRequestRawPrompt
        }

        logger.info("Successfully retrieved context in PromptGenerationService: $vectorResponse")

        return try {
            val jsonElement = json.parseToJsonElement(vectorResponse)
            val results = jsonElement.jsonObject["data"]?.jsonObject?.get("retrieval_results")?.jsonArray

            val contextBuilder = StringBuilder()
            if (results != null && results.isNotEmpty()) {
                results.forEach { result ->
                    val noteValue = result.jsonObject["entity"]?.jsonObject?.get("note_value")?.jsonPrimitive?.content
                    if (!noteValue.isNullOrBlank()) {
                        contextBuilder.append("- ").append(noteValue.trim()).append("\n\n")
                    }
                }
            }

            val extractedContext = contextBuilder.toString().trim()
            if (extractedContext.isNotEmpty()) {
                "$userRequestRawPrompt\n\n Here is " +
                        "some context from my knowledge " +
                        "base, use your knowledge along with this information" +
                        " to " +
                        "improve your answer :\n$extractedContext"
            } else {
                userRequestRawPrompt
            }
        } catch (e: Exception) {
            logger.error("Failed to parse retrieval response", e)
            userRequestRawPrompt
        }
    }
}
