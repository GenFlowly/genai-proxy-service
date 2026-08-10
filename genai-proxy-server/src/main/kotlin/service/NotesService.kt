package com.genflowly.service

import com.genflowly.providers.DynamoDBProvider
import io.ktor.client.HttpClient
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.contentType
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import org.slf4j.LoggerFactory
import io.ktor.client.statement.bodyAsText
import io.ktor.http.isSuccess

@Serializable
data class NoteData(
    val note_key: String,
    val note_value: String,
    val title: String,
    val created_at: String
)

@Serializable
data class SaveNoteRequest(
    val client: String,
    val data: NoteData
)

class NotesService(
    private val httpClient: HttpClient,
    private val dynamoDBProvider: DynamoDBProvider
) {
    private val logger = LoggerFactory.getLogger(NotesService::class.java)
    private val encodingServerUrl = System.getenv("ENCODING_SERVER_URL") ?: "https://api-encode-development.genflowly.com"

    suspend fun saveNoteAsync(customerId: String, request: SaveNoteRequest) {
        // 1. Save to DynamoDB
        dynamoDBProvider.saveNote(
            customerId = customerId,
            noteKey = request.data.note_key,
            noteValue = request.data.note_value,
            title = request.data.title,
            createdAt = request.data.created_at
        )

        // 2. Async call to encoding server
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val url = "$encodingServerUrl/encode-notes"
                logger.info("Sending note to encoding server asynchronously: $url")
                
                val response = httpClient.post(url) {
                    contentType(ContentType.Application.Json)
                    setBody(request)
                }

                if (response.status.isSuccess()) {
                    logger.info("Successfully sent note to encoding server")
                } else {
                    logger.error("Failed to send note to encoding server: ${response.status} ${response.bodyAsText()}")
                }
            } catch (e: Exception) {
                logger.error("Error sending note to encoding server asynchronously", e)
            }
        }
    }
}
