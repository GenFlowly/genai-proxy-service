package com.genflowly.activity

import com.genflowly.Routes
import com.genflowly.activity.generation.registerGenerateTextStreamRoutes
import com.genflowly.di.AppScope
import com.genflowly.models.ApiKeyPrincipal
import com.genflowly.service.ConversationIndexingService
import com.genflowly.service.ExchangeSideEffects
import com.genflowly.service.GenerationOrchestrator
import com.genflowly.service.MemoryExtractionService
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.auth.Authentication
import io.ktor.server.auth.bearer
import io.ktor.server.engine.embeddedServer
import io.ktor.server.metrics.micrometer.MicrometerMetrics
import io.ktor.server.netty.Netty
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.routing.routing
import io.ktor.server.testing.testApplication
import io.micrometer.core.instrument.simple.SimpleMeterRegistry
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.net.Socket
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * POST /generate-text-stream when the client drops mid-reply (mobile browsers
 * kill the stream when the app is backgrounded): generation runs on and the
 * reply is persisted, so the exchange is still learned from and indexed —
 * once the reply exists — and the disconnect is recorded as 499 (client
 * closed request), not a 500.
 */
class GenerateTextStreamRoutesTest {

    private val customerId = "CU-1"
    private val orchestrator = mockk<GenerationOrchestrator>()
    private val memoryExtraction = mockk<MemoryExtractionService>(relaxed = true)
    private val indexing = mockk<ConversationIndexingService>(relaxed = true)
    private val sideEffects = ExchangeSideEffects(memoryExtraction, indexing, AppScope())
    private val meterRegistry = SimpleMeterRegistry()

    /** What the generation job pushes; closed (as in production) only after the reply is persisted. */
    private val chunks = Channel<String>(Channel.UNLIMITED)

    private val requestJson = """
        {"aiConfig":{"aiVendor":"OPENAI","model":"gpt-5"},
         "prompt":{"instructionId":"","instructionVersion":"","prompt":"Tell me about the ocean"},
         "selectedResponseId":null,"conversationId":null,"client":"web"}
    """.trimIndent()

    private fun Application.streamModule() {
        install(ContentNegotiation) { json() }
        install(MicrometerMetrics) { registry = meterRegistry }
        install(Authentication) {
            bearer("auth0") { authenticate { null } }
            bearer("apiKey") { authenticate { ApiKeyPrincipal(customerId) } }
        }
        routing {
            registerGenerateTextStreamRoutes(orchestrator, mockk(relaxed = true), sideEffects)
        }
        coEvery {
            orchestrator.processTextGenerateStreamRequest(
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any()
            )
        } returns GenerationOrchestrator.StreamExecutionResult(
            conversationId = "CONV-1",
            messageId = "MSG-1",
            flow = chunks.receiveAsFlow(),
            responseMessageId = "RESP-1"
        )
    }

    /** Statuses the stream route finished with, as the production HTTP metrics record them. */
    private fun recordedStatuses(): List<String> =
        meterRegistry.find("ktor.http.server.requests").timers()
            .filter { it.id.getTag("route")?.endsWith(Routes.GENERATE_TEXT_STREAM) == true }
            .map { it.id.getTag("status").orEmpty() }

    @Test
    fun `a client that stays connected gets the reply and the exchange is learned from and indexed`() = testApplication {
        application { streamModule() }
        chunks.send("The ocean")
        chunks.close()

        val response = client.post(Routes.GENERATE_TEXT_STREAM) {
            bearerAuth("gfy_test")
            contentType(ContentType.Application.Json)
            setBody(requestJson)
        }

        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals(" The ocean", response.bodyAsText())
        coVerify(exactly = 1) { memoryExtraction.enqueueConversationExtraction(customerId, "CONV-1", "RESP-1") }
        verify(exactly = 1) { indexing.indexExchangeAsync(customerId, "CONV-1", "web", "Tell me about the ocean", "RESP-1", "gfy_test") }
    }

    /** Real Netty and a real socket: the disconnect has to fail the server's writes as it does in production. */
    @Test
    fun `a client that disconnects mid-reply is not a 500 and the exchange is still learned from and indexed`() = runBlocking {
        val indexed = CompletableDeferred<Unit>()
        every { indexing.indexExchangeAsync(any(), any(), any(), any(), any(), any()) } answers { indexed.complete(Unit) }
        val server = embeddedServer(Netty, port = 0) { streamModule() }.start(wait = false)
        try {
            val port = server.engine.resolvedConnectors().first().port
            Socket("localhost", port).use { socket ->
                val body = requestJson.toByteArray()
                socket.getOutputStream().apply {
                    write(
                        ("POST ${Routes.GENERATE_TEXT_STREAM} HTTP/1.1\r\nHost: localhost\r\n" +
                            "Authorization: Bearer gfy_test\r\nContent-Type: application/json\r\n" +
                            "Content-Length: ${body.size}\r\n\r\n").toByteArray()
                    )
                    write(body)
                    flush()
                }
                // Headers and the heartbeat chunk (" "), then the client goes away.
                val received = StringBuilder()
                val input = socket.getInputStream()
                while (!received.contains("\r\n\r\n1\r\n \r\n")) received.append(input.read().toChar())
            }

            // Generation keeps going without the client until the relay's
            // writes hit the dead connection and the route finishes.
            withTimeout(10_000) {
                while (recordedStatuses().isEmpty()) {
                    chunks.send("The ocean covers most of the planet. ")
                    delay(20)
                }
            }
            assertEquals(listOf("499"), recordedStatuses())
            // The reply isn't persisted until generation ends — nothing may read it yet.
            coVerify(exactly = 0) { memoryExtraction.enqueueConversationExtraction(any(), any(), any()) }
            verify(exactly = 0) { indexing.indexExchangeAsync(any(), any(), any(), any(), any(), any()) }

            chunks.close()  // reply persisted

            withTimeout(5_000) { indexed.await() }
            coVerify(exactly = 1) { memoryExtraction.enqueueConversationExtraction(customerId, "CONV-1", "RESP-1") }
            verify(exactly = 1) { indexing.indexExchangeAsync(customerId, "CONV-1", "web", "Tell me about the ocean", "RESP-1", "gfy_test") }
        } finally {
            server.stop(0, 0)
        }
    }
}
