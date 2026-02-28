package com.genflowly.service

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import mu.KLogger
import io.ktor.client.*
import io.ktor.client.engine.cio.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.client.plugins.HttpTimeout

@Serializable
private data class RetrievalLambdaPayload(
    val customer_id: String,
    val data: RetrievalLambdaData
)

@Serializable
private data class RetrievalLambdaData(
    val query_data: QueryData,
    val top_n: Int = 3
)

@Serializable
private data class QueryData(
    val note_value: String,
    val chunking_type: String = "semantic"
)

class RetrievalService(
    private val logger: KLogger,
    private val json: Json
) {
    // Read the server URL from environment variables
    private val retrievalServerUrl: String = System.getenv("RETRIEVAL_SERVER_URL") ?: "http://retrieval-server:5001"

    // Instantiate Http Client
    private val client = HttpClient(CIO) {
        install(HttpTimeout) {
            requestTimeoutMillis = 300_000L
            connectTimeoutMillis = 30_000L
            socketTimeoutMillis = 300_000L
        }
    }

    suspend fun retrieveContext(customerId: String, userPrompt: String, systemPrompt: String?): String? {
        logger.info { "Retrieving context for customer $customerId using URL: $retrievalServerUrl/retrieve" }

        // We reuse the note_value processor as requested by the user, squashing the system & user prompts
        val combinedPrompt = "${systemPrompt ?: ""}\n\n$userPrompt"
        
        val payload = RetrievalLambdaPayload(
            customer_id = customerId,
            data = RetrievalLambdaData(
                query_data = QueryData(
                    note_value = combinedPrompt
                )
            )
        )

        val payloadJson = json.encodeToString(payload)

        return try {
            val response: HttpResponse = client.post("$retrievalServerUrl/retrieve") {
                contentType(ContentType.Application.Json)
                setBody(payloadJson)
            }
            
            val resultJson = response.bodyAsText()

            if (!response.status.isSuccess()) {
                logger.error { "Retrieval Server returned an error: $resultJson" }
                return null
            }

            logger.info { "Successfully retrieved context for customer $customerId" }
            resultJson

        } catch (e: Exception) {
            logger.error(e) { "Failed to invoke Retrieval Server" }
            null
        }
    }
}
