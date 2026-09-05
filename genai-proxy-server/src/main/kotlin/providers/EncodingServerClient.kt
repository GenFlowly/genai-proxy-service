package com.genflowly.providers

import io.ktor.client.HttpClient
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import com.genflowly.EmbeddingConstants
import com.genflowly.models.encoding.EncodingCreateCollectionsRequest
import com.genflowly.models.encoding.EncodingSaveConversationRequest
import com.genflowly.models.encoding.EncodingSaveInstructionRequest
import com.genflowly.models.encoding.EncodingSaveMemoryRequest
import com.genflowly.models.encoding.EncodingSaveNoteRequest
import mu.KLogger

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
                contentType(ContentType.Application.Json)
                setBody(
                    EncodingCreateCollectionsRequest(
                        modelType = EmbeddingConstants.MODEL_TYPE,
                        modelName = EmbeddingConstants.MODEL_NAME
                    )
                )
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

    /**
     * Pushes a memory into the realtime embedding pipeline (/encode-memories).
     * Transport failures are logged, not thrown — memory embedding is
     * best-effort; the DDB row remains the source of truth.
     */
    suspend fun encodeMemory(request: EncodingSaveMemoryRequest, bearerToken: String) {
        val baseUrl = configuredUrl
        if (baseUrl == null) {
            logger.warn { "ENCODING_SERVER_URL is not set. Skipping memory encoding for ${request.data.memoryKey}." }
            return
        }
        val url = "$baseUrl/encode-memories"
        try {
            val response = httpClient.post(url) {
                contentType(ContentType.Application.Json)
                header("Authorization", "Bearer $bearerToken")
                setBody(request)
            }
            if (response.status.isSuccess()) {
                logger.info { "Successfully sent memory ${request.data.memoryKey} to encoding server" }
            } else {
                val errorBody = response.bodyAsText()
                logger.error { "Failed to send memory to encoding server: ${response.status} $errorBody" }
            }
        } catch (e: Exception) {
            logger.error(e) { "Error sending memory to encoding server" }
        }
    }

    /**
     * Pushes an instruction version into the realtime embedding pipeline
     * (/encode-instructions). Transport failures are logged, not thrown —
     * indexing is best-effort; the Instructions table is the source of truth.
     */
    suspend fun encodeInstruction(request: EncodingSaveInstructionRequest, bearerToken: String) {
        val baseUrl = configuredUrl
        if (baseUrl == null) {
            logger.warn { "ENCODING_SERVER_URL is not set. Skipping instruction encoding for ${request.data.instructionId}." }
            return
        }
        val url = "$baseUrl/encode-instructions"
        try {
            val response = httpClient.post(url) {
                contentType(ContentType.Application.Json)
                header("Authorization", "Bearer $bearerToken")
                setBody(request)
            }
            if (response.status.isSuccess()) {
                logger.info { "Successfully sent instruction ${request.data.instructionId} v${request.data.version} to encoding server" }
            } else {
                val errorBody = response.bodyAsText()
                logger.error { "Failed to send instruction to encoding server: ${response.status} $errorBody" }
            }
        } catch (e: Exception) {
            logger.error(e) { "Error sending instruction to encoding server" }
        }
    }

    /**
     * Pushes a completed conversation exchange into the realtime embedding
     * pipeline (/encode-conversations). Transport failures are logged, not
     * thrown — indexing is best-effort; the Message table is the source of truth.
     */
    suspend fun encodeConversation(request: EncodingSaveConversationRequest, bearerToken: String) {
        val baseUrl = configuredUrl
        if (baseUrl == null) {
            logger.warn { "ENCODING_SERVER_URL is not set. Skipping conversation encoding for ${request.data.messageKey}." }
            return
        }
        val url = "$baseUrl/encode-conversations"
        try {
            val response = httpClient.post(url) {
                contentType(ContentType.Application.Json)
                header("Authorization", "Bearer $bearerToken")
                setBody(request)
            }
            if (response.status.isSuccess()) {
                logger.info { "Successfully sent conversation exchange ${request.data.messageKey} to encoding server" }
            } else {
                val errorBody = response.bodyAsText()
                logger.error { "Failed to send conversation exchange to encoding server: ${response.status} $errorBody" }
            }
        } catch (e: Exception) {
            logger.error(e) { "Error sending conversation exchange to encoding server" }
        }
    }
}
