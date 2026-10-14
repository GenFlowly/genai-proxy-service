package com.genflowly.providers

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.HttpTimeout
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import mu.KotlinLogging
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

/**
 * Non-streaming generation: when the retrieval-server rejects an attachment it
 * cannot use (422 attachment_error), its readable message reaches the caller
 * instead of the generic "No response received".
 */
class RetrievalServerClientAttachmentErrorTest {

    private val json = Json { ignoreUnknownKeys = true }

    private fun client(status: HttpStatusCode, body: String) = RetrievalServerClient(
        KotlinLogging.logger("RetrievalServerClientAttachmentErrorTest"),
        json,
        HttpClient(MockEngine {
            respond(body, status, headersOf(HttpHeaders.ContentType, "application/json"))
        }) { install(HttpTimeout) },
        "http://retrieval-server:5001"
    )

    private suspend fun RetrievalServerClient.generate() = retrieveAndGenerate(
        customerId = "cust-1",
        client = "web",
        query = "what is this?",
        llmCredentials = mapOf("anthropic_api_key" to "sk-test"),
        llmProvider = "anthropic",
        llmModel = "claude-test"
    )

    @Test
    fun `an attachment error carries its user-facing message`() = runTest {
        val message = "The attached file isn't a supported image (detected: SVG)."
        val result = client(
            HttpStatusCode.UnprocessableEntity,
            """{"detail":{"error_type":"attachment_error","message":"$message"}}"""
        ).generate()

        assertNull(result.text)
        assertEquals(message, result.errorMessage)
    }

    @Test
    fun `other failures keep no message`() = runTest {
        for ((status, body) in listOf(
            HttpStatusCode.InternalServerError to """{"detail":"Graph error: boom"}""",
            HttpStatusCode.UnprocessableEntity to """{"detail":[{"loc":["body"],"msg":"field required"}]}""",
            HttpStatusCode.BadGateway to "not json"
        )) {
            val result = client(status, body).generate()
            assertNull(result.text, body)
            assertNull(result.errorMessage, body)
        }
    }
}
