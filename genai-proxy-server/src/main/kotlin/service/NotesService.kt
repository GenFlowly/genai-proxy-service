package com.genflowly.service

import com.genflowly.providers.DynamoDBProvider
import io.ktor.client.HttpClient
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.request.header
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
    val note_key: String = "default_key",
    val note_value: String,
    val title: String = "Untitled",
    val created_at: String
)

@Serializable
data class SaveNoteRequest(
    val client: String,
    val data: NoteData
)

@Serializable
data class CustomerNote(
    val noteKey: String,
    val noteValue: String,
    val title: String,
    val createdAt: String,
    val updatedAt: String
)

@Serializable
data class GetNotesResponse(
    val notes: List<CustomerNote>
)

@Serializable
data class EncodingNoteData(
    val note_key: String,
    val noteKey: String,
    val note_id: String,
    val note_value: String,
    val noteValue: String,
    val title: String,
    val created_at: String,
    val createdAt: String
)

@Serializable
data class EncodingSaveNoteRequest(
    val dataType: String,
    val client: String,
    val data: EncodingNoteData
)

class NotesService(
    private val httpClient: HttpClient,
    private val dynamoDBProvider: DynamoDBProvider
) {
    private val logger = LoggerFactory.getLogger(NotesService::class.java)
    private val encodingServerUrl = System.getenv("ENCODING_SERVER_URL") ?: "https://api-encode-development.genflowly.com"

    suspend fun getNotes(customerId: String): GetNotesResponse {
        val items = dynamoDBProvider.getNotes(customerId)
        val notes = items.map { item ->
            CustomerNote(
                noteKey = item["noteKey"]?.s() ?: "",
                noteValue = item["noteValue"]?.s() ?: "",
                title = item["title"]?.s() ?: "Untitled",
                // noteCreatedAt is the client-supplied creation time; createdAt is the DDB write time
                createdAt = item["noteCreatedAt"]?.s() ?: item["createdAt"]?.s() ?: "",
                updatedAt = item["updatedAt"]?.s() ?: ""
            )
        }.sortedByDescending { it.createdAt }
        return GetNotesResponse(notes = notes)
    }

    suspend fun saveNoteAsync(customerId: String, request: SaveNoteRequest, token: String) {
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
                
                val encodingRequest = EncodingSaveNoteRequest(
                    dataType = "NOTE",
                    client = request.client,
                    data = EncodingNoteData(
                        note_key = request.data.note_key,
                        noteKey = request.data.note_key,
                        note_id = request.data.note_key,
                        note_value = request.data.note_value,
                        noteValue = request.data.note_value,
                        title = request.data.title,
                        created_at = request.data.created_at,
                        createdAt = request.data.created_at
                    )
                )

                val response = httpClient.post(url) {
                    contentType(ContentType.Application.Json)
                    header("Authorization", "Bearer $token")
                    setBody(encodingRequest)
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
