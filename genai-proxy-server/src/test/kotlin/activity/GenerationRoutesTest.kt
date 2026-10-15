package com.genflowly.activity

import com.genflowly.Routes
import com.genflowly.activity.generation.registerGenerateTextRoutes
import com.genflowly.activity.generation.registerGenerateTextStreamRoutes
import com.genflowly.models.AIConfig
import com.genflowly.models.AIVendor
import com.genflowly.models.ApiKeyPrincipal
import com.genflowly.models.Message
import com.genflowly.service.ExchangeSideEffects
import com.genflowly.service.GenerationOrchestrator
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.auth.Authentication
import io.ktor.server.auth.bearer
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.routing.routing
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.flow.flowOf
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The generate routes over HTTP: the browser's Accept-Language reaches the
 * orchestrator as the locale (6.1).
 */
class GenerationRoutesTest {

    private val customerId = "cust-1"
    private val orchestrator = mockk<GenerationOrchestrator>()
    private val streamLocales = mutableListOf<String?>()
    private val batchLocales = mutableListOf<String?>()

    init {
        coEvery {
            orchestrator.processTextGenerateStreamRequest(
                any(), any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any(), any(), any(), any(), any(), any(), captureNullable(streamLocales)
            )
        } returns GenerationOrchestrator.StreamExecutionResult(
            "conv-1", "msg-1", flowOf("{\"t\":\"c\",\"v\":\"hi\"}\n"), "resp-1"
        )
        coEvery {
            orchestrator.processTextGenerateRequest(
                any(), any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any(), any(), any(), any(), any(), any(), captureNullable(batchLocales)
            )
        } returns listOf(
            Message(
                conversationId = "conv-1", text = "hi", client = "REACT_APP", role = "assistant",
                customerId = customerId, systemPrompt = "", previousMessageId = "msg-1",
                aiConfig = listOf(AIConfig(aiVendor = AIVendor.OPENAI, model = "model-x"))
            )
        )
    }

    private fun ApplicationTestBuilder.setUpRoutes() {
        install(ContentNegotiation) { json() }
        install(Authentication) {
            bearer("auth0") { authenticate { null } }
            bearer("apiKey") { authenticate { ApiKeyPrincipal(customerId) } }
        }
        routing {
            val exchangeSideEffects = mockk<ExchangeSideEffects>(relaxed = true)
            registerGenerateTextRoutes(orchestrator, mockk(relaxed = true), exchangeSideEffects)
            registerGenerateTextStreamRoutes(orchestrator, mockk(relaxed = true), exchangeSideEffects)
        }
    }

    private val prompt = """{"instructionId":"","instructionVersion":"","prompt":"hi"}"""
    private val streamBody =
        """{"aiConfig":{"aiVendor":"OPENAI","model":"model-x"},"prompt":$prompt,"selectedResponseId":null,"conversationId":null,"client":"REACT_APP"}"""
    private val batchBody =
        """{"aiConfig":[{"aiVendor":"OPENAI","model":"model-x"}],"prompt":$prompt,"selectedResponseId":null,"conversationId":null,"client":"REACT_APP"}"""

    private suspend fun ApplicationTestBuilder.post(route: String, body: String, acceptLanguage: String?) =
        client.post(route) {
            bearerAuth("gfy_test")
            contentType(ContentType.Application.Json)
            acceptLanguage?.let { header(HttpHeaders.AcceptLanguage, it) }
            setBody(body)
        }

    @Test
    fun `the stream route sends the first Accept-Language tag as the locale`() = testApplication {
        setUpRoutes()

        val response = post(Routes.GENERATE_TEXT_STREAM, streamBody, "de-DE,de;q=0.9,en;q=0.8")

        assertEquals(HttpStatusCode.OK, response.status)
        response.bodyAsText()
        assertEquals(listOf<String?>("de-DE"), streamLocales)
    }

    @Test
    fun `the batch route sends the first Accept-Language tag as the locale`() = testApplication {
        setUpRoutes()

        val response = post(Routes.GENERATE_TEXT, batchBody, "en-US,en;q=0.9")

        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals(listOf<String?>("en-US"), batchLocales)
    }

    @Test
    fun `without a usable Accept-Language the locale is null`() = testApplication {
        setUpRoutes()

        post(Routes.GENERATE_TEXT_STREAM, streamBody, acceptLanguage = null).bodyAsText()
        post(Routes.GENERATE_TEXT_STREAM, streamBody, acceptLanguage = "*").bodyAsText()
        post(Routes.GENERATE_TEXT, batchBody, acceptLanguage = null)

        assertEquals(listOf<String?>(null, null), streamLocales)
        assertEquals(listOf<String?>(null), batchLocales)
    }
}
