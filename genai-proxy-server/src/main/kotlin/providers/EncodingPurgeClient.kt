package com.genflowly.providers

import io.ktor.client.HttpClient
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import mu.KLogger

/**
 * The encoding-server's POST /purge-vectors (plan 3.9): deletes a
 * conversation's exchange vectors from a customer's conversation collections,
 * or drops all of a customer's collections. Authenticated with an Auth0
 * client-credentials token (the encoding-server accepts only allowed service
 * clients there). Both calls are idempotent; failures throw so the purge job
 * retries.
 */
class EncodingPurgeClient(
    private val httpClient: HttpClient,
    private val logger: KLogger,
    private val encodingServerUrl: String?,
    private val tokenProvider: Auth0M2MTokenProvider,
    private val audience: String?
) {
    /** False when the encoding server, the M2M credentials or the audience is missing. */
    val isConfigured: Boolean
        get() = !encodingServerUrl.isNullOrBlank() && tokenProvider.isConfigured && !audience.isNullOrBlank()

    suspend fun deleteConversationVectors(customerId: String, conversationId: String) =
        post(mapOf("customerId" to customerId, "conversationId" to conversationId), "delete_conversation")

    suspend fun dropCustomerCollections(customerId: String) =
        post(mapOf("customerId" to customerId, "dropCollections" to true), "drop_collections")

    private suspend fun post(fields: Map<String, Any>, action: String) {
        check(isConfigured) { "The encoding-server purge is not configured" }
        val token = tokenProvider.token(audience!!)
        val body = JsonObject(fields.mapValues { (_, v) ->
            when (v) {
                is Boolean -> JsonPrimitive(v)
                else -> JsonPrimitive(v.toString())
            }
        })
        val response = httpClient.post("$encodingServerUrl/purge-vectors") {
            bearerAuth(token)
            contentType(ContentType.Application.Json)
            setBody(body.toString())
        }
        if (!response.status.isSuccess()) {
            logger.warn { "Encoding-server vector purge ($action) returned ${response.status.value}" }
            throw IllegalStateException("Vector purge ($action) failed with ${response.status.value}")
        }
    }
}
