package com.genflowly.activity

import com.genflowly.Routes
import com.genflowly.activity.generation.registerGenerateTextRoutes
import com.genflowly.activity.generation.registerGenerateTextStreamRoutes
import com.genflowly.activity.generation.registerRunRoutes
import com.genflowly.models.AIConfig
import com.genflowly.models.AIVendor
import com.genflowly.models.ApiKeyPrincipal
import com.genflowly.models.Message
import com.genflowly.models.retrieval.StreamChunk
import com.genflowly.providers.RunsClient
import com.genflowly.service.ConversationService
import com.genflowly.service.ExchangeSideEffects
import com.genflowly.service.GenerationOrchestrator
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.get
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
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The generate and reattach routes over HTTP: the browser's Accept-Language
 * reaches the orchestrator as the locale (6.1), and silences on the live and
 * reattach streams are filled with whitespace-only keepalive lines (1.7).
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

    /** Both providers the routes accept; an API-key principal carries the customerId directly. */
    private fun ApplicationTestBuilder.installAuth() {
        install(Authentication) {
            bearer("auth0") { authenticate { null } }
            bearer("apiKey") { authenticate { ApiKeyPrincipal(customerId) } }
        }
    }

    private fun ApplicationTestBuilder.setUpRoutes() {
        install(ContentNegotiation) { json() }
        installAuth()
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

    // ── Request validation (4.4) ────────────────────────────────────────────

    @Test
    fun `a request the validator refuses is a 400 with its message, other failures stay 500`() = testApplication {
        setUpRoutes()
        coEvery {
            orchestrator.processTextGenerateStreamRequest(
                any(), any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any(), any(), any(), any(), any(), any(), anyNullable()
            )
        } throws com.genflowly.service.RequestValidationException(
            "At most 5 PDFs are allowed per message (this message has 6)"
        )

        val refused = post(Routes.GENERATE_TEXT_STREAM, streamBody, null)

        assertEquals(HttpStatusCode.BadRequest, refused.status)
        assertTrue(refused.bodyAsText().contains("At most 5 PDFs are allowed per message"))

        coEvery {
            orchestrator.processTextGenerateRequest(
                any(), any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any(), any(), any(), any(), any(), any(), anyNullable()
            )
        } throws IllegalStateException("boom")

        assertEquals(HttpStatusCode.InternalServerError, post(Routes.GENERATE_TEXT, batchBody, null).status)
    }

    // ── Keepalives during silences (1.7) ────────────────────────────────────

    private val first = "{\"t\":\"c\",\"v\":\"Working on it\"}\n"
    private val last = "{\"t\":\"c\",\"v\":\" - done.\"}\n"

    /** Splits a relayed body into its frames and its whitespace-only keepalive lines. */
    private fun framesAndKeepalives(body: String): Pair<List<String>, Int> {
        assertTrue(body.startsWith(" "), "the heartbeat byte comes first")
        val lines = body.removePrefix(" ").split("\n").dropLast(1)
        return lines.filter { it.isNotBlank() }.map { "$it\n" } to lines.count { it.isNotEmpty() && it.isBlank() }
    }

    @Test
    fun `the stream route writes whitespace lines while the turn is silent`() = testApplication {
        coEvery {
            orchestrator.processTextGenerateStreamRequest(
                any(), any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any(), any(), any(), any(), any(), any(), any()
            )
        } returns GenerationOrchestrator.StreamExecutionResult(
            "conv-1", "msg-1",
            flow {
                emit(first)
                delay(300) // a tool runs
                emit(last)
            },
            "resp-1"
        )
        install(ContentNegotiation) { json() }
        installAuth()
        routing {
            registerGenerateTextStreamRoutes(
                orchestrator, mockk(relaxed = true), mockk<ExchangeSideEffects>(relaxed = true),
                keepaliveIntervalMs = 50
            )
        }

        val body = client.post(Routes.GENERATE_TEXT_STREAM) {
            bearerAuth("gfy_test")
            contentType(ContentType.Application.Json)
            setBody(streamBody)
        }.bodyAsText()

        val (frames, keepalives) = framesAndKeepalives(body)
        assertEquals(listOf(first, last), frames)
        assertTrue(keepalives >= 2, "keepalives: $keepalives in ${body.replace("\n", "\\n")}")
    }

    @Test
    fun `the reattach route writes whitespace lines while the run is silent`() = testApplication {
        val runsClient = mockk<RunsClient>()
        every { runsClient.streamRun("run_1", 0) } returns flow {
            emit(StreamChunk.Content("Working on it"))
            delay(300) // the run waits in the queue
            emit(StreamChunk.Content(" - done."))
        }
        val conversationService = mockk<ConversationService>()
        coEvery { conversationService.pendingRunIdsIfAccessible("conv-1", customerId) } returns setOf("run_1")
        installAuth()
        routing { registerRunRoutes(runsClient, mockk(relaxed = true), conversationService, keepaliveIntervalMs = 50) }

        val body = client.get(Routes.REATTACH_RUN.replace("{runId}", "run_1") + "?conversationId=conv-1") {
            bearerAuth("gfy_test")
        }.bodyAsText()

        val (frames, keepalives) = framesAndKeepalives(body)
        assertEquals(listOf(first, last), frames)
        assertTrue(keepalives >= 2, "keepalives: $keepalives in ${body.replace("\n", "\\n")}")
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
