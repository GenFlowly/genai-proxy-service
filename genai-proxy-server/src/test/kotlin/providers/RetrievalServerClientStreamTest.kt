package com.genflowly.providers

import com.genflowly.di.provideJson
import com.genflowly.models.retrieval.StreamChunk
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import mu.KotlinLogging
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The stateless /retrieve stream: the server ends every stream with [DONE],
 * so one that stops without it was cut off and ends with an error instead of
 * reading as a complete answer; a rejected request fails with its reason.
 */
class RetrievalServerClientStreamTest {

    private val interrupted = StreamChunk.Error(
        "The response was interrupted before it finished. Please try again.", "stream_lost"
    )

    private fun client(handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData) =
        RetrievalServerClient(
            KotlinLogging.logger("RetrievalServerClientStreamTest"), provideJson(),
            HttpClient(MockEngine(handler)) { install(HttpTimeout) },
            "http://retrieval-server:5001"
        )

    private fun MockRequestHandleScope.sse(body: String) =
        respond(body, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "text/event-stream"))

    private suspend fun RetrievalServerClient.stream(): List<StreamChunk> = retrieveAndGenerateStream(
        customerId = "cust-1",
        client = "web",
        query = "hi",
        llmCredentials = mapOf("anthropic_api_key" to "sk-test"),
        llmProvider = "anthropic",
        llmModel = "claude-test"
    ).toList()

    @Test
    fun `a stream that ends with DONE is complete`() = runTest {
        val chunks = client { sse("data: {\"content\":\"Hello\"}\n\ndata: [DONE]\n\n") }.stream()

        assertEquals(listOf<StreamChunk>(StreamChunk.Content("Hello")), chunks)
    }

    @Test
    fun `a stream that stops before DONE ends with the interrupted error`() = runTest {
        val chunks = client { sse("data: {\"content\":\"Hel\"}\n\n") }.stream()

        assertEquals(listOf(StreamChunk.Content("Hel"), interrupted), chunks)
    }

    @Test
    fun `a request that fails without a response ends with the interrupted error`() = runTest {
        val chunks = client { throw java.net.SocketTimeoutException("Socket timeout has expired") }.stream()

        assertEquals(listOf<StreamChunk>(interrupted), chunks)
    }

    @Test
    fun `the server's own error event before DONE is the only error`() = runTest {
        val chunks = client {
            sse("data: {\"content\":\"Par\"}\n\ndata: {\"error\":\"Quota exceeded.\",\"error_type\":\"rate_limit\"}\n\ndata: [DONE]\n\n")
        }.stream()

        assertEquals(listOf(StreamChunk.Content("Par"), StreamChunk.Error("Quota exceeded.", "rate_limit")), chunks)
    }

    @Test
    fun `a rejected attachment fails the stream with its readable reason`() = runTest {
        val reason = "The attached file isn't a supported image (detected: SVG)."
        val chunks = client {
            respond(
                """{"detail":{"error_type":"attachment_error","message":"$reason"}}""",
                HttpStatusCode.UnprocessableEntity,
                headersOf(HttpHeaders.ContentType, "application/json")
            )
        }.stream()

        assertEquals(listOf<StreamChunk>(StreamChunk.Error(reason, "attachment_error")), chunks)
    }

    @Test
    fun `any other rejection fails the stream with the generic reason`() = runTest {
        val chunks = client {
            respond("""{"detail":"Graph error: boom"}""", HttpStatusCode.InternalServerError,
                headersOf(HttpHeaders.ContentType, "application/json"))
        }.stream()

        assertEquals(listOf<StreamChunk>(StreamChunk.Error("The response could not be completed.", "error")), chunks)
    }

    @Test
    fun `malformed chunks are skipped`() = runTest {
        val chunks = client {
            sse("data: not json\n\ndata: {\"usage\":42}\n\ndata: {\"content\":\"ok\"}\n\ndata: [DONE]\n\n")
        }.stream()

        assertEquals(listOf<StreamChunk>(StreamChunk.Content("ok")), chunks)
    }
}
