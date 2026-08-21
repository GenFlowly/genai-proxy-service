package com.genflowly.providers

import io.ktor.client.HttpClient
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.serialization.Serializable
import mu.KLogger

/**
 * Wire format the encoding server expects for a note. Carries both snake_case
 * and camelCase copies of every field for compatibility with the server's
 * mixed readers — do not trim without coordinating with encoding-server.
 */
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

/**
 * The single HTTP client for the encoding-server (embedding pipeline). No
 * business logic — callers own scheduling (fire-and-forget vs awaited) and
 * any batching decisions.
 */
class EncodingServerClient(
    private val httpClient: HttpClient,
    private val logger: KLogger,
    private val configuredUrl: String?
) {

    /**
     * Ensures the customer's vector collections exist. Skips (with a warning)
     * when no encoding server is configured — collection creation is a
     * best-effort onboarding enhancement.
     */
    suspend fun ensureCollections(customerId: String, authHeader: String) {
        val baseUrl = configuredUrl
        if (baseUrl == null) {
            logger.warn { "ENCODING_SERVER_URL is not set. Skipping collection check/creation." }
            return
        }
        try {
            logger.info { "Ensuring collections exist for customerId=$customerId on encoding server $baseUrl" }
            val createRes = httpClient.post("$baseUrl/create-collections") {
                header("Authorization", authHeader)
            }
            val createBody = createRes.bodyAsText()

            if (!createRes.status.isSuccess()) {
                logger.error { "Collection creation/check failed with status ${createRes.status}. Body: $createBody" }
            } else {
                logger.info { "Collections successfully verified/created for customerId=$customerId" }
            }
        } catch (e: Exception) {
            logger.error(e) { "Failed to ensure collection creation for customer $customerId" }
        }
    }

    /**
     * Pushes a note into the realtime embedding pipeline (/encode-notes).
     * Transport failures are logged, not thrown — encoding is best-effort.
     */
    suspend fun encodeNote(request: EncodingSaveNoteRequest, bearerToken: String) {
        val baseUrl = configuredUrl
        if (baseUrl == null) {
            logger.warn { "ENCODING_SERVER_URL is not set. Skipping note encoding for note ${request.data.noteKey}." }
            return
        }
        val url = "$baseUrl/encode-notes"
        try {
            logger.info { "Sending note to encoding server: $url" }
            val response = httpClient.post(url) {
                contentType(ContentType.Application.Json)
                header("Authorization", "Bearer $bearerToken")
                setBody(request)
            }
            if (response.status.isSuccess()) {
                logger.info { "Successfully sent note to encoding server" }
            } else {
                val errorBody = response.bodyAsText()
                logger.error { "Failed to send note to encoding server: ${response.status} $errorBody" }
            }
        } catch (e: Exception) {
            logger.error(e) { "Error sending note to encoding server" }
        }
    }
}
