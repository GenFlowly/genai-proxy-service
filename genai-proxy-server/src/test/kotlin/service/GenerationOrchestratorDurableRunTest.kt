package com.genflowly.service

import com.genflowly.config.AppConfig
import com.genflowly.di.AppScope
import com.genflowly.di.provideJson
import com.genflowly.models.AIConfig
import com.genflowly.models.AIVendor
import com.genflowly.models.Message
import com.genflowly.models.api.InstructionResponse
import com.genflowly.providers.RunsClient
import com.genflowly.repository.PendingRun
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.coVerifyOrder
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import mu.KotlinLogging
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Durable turns (0.3), through a real RunsClient over a scripted
 * retrieval-server: a stream that ends without its run's terminal event is a
 * failure the user sees and that is stored, the first error of a failed run is
 * the user-facing one, and the pending run goes only after the message is
 * stored, once the run can publish nothing more.
 */
class GenerationOrchestratorDurableRunTest {

    private val cust = "cust-1"
    private val aiConfig = listOf(AIConfig(aiVendor = AIVendor.OPENAI, model = "model-x"))
    private val interrupted = "The response was interrupted before it finished. Please try again."

    private val instructionService = mockk<InstructionService>(relaxed = true)
    private val conversationService = mockk<ConversationService>(relaxed = true)
    private val credentialsService = mockk<CustomerCredentialsService>()
    private val appConfig = mockk<AppConfig>(relaxed = true)

    init {
        coEvery { instructionService.resolveDefaultInstruction(cust) } returns InstructionResponse(
            id = "i1", version = 1, name = "Coach", instruction = "be kind"
        )
        coEvery { conversationService.resolveWritableConversationId(cust, any(), any(), any()) } returns "conv-1"
        coEvery { credentialsService.getCustomerApiKeyForVendor(any(), cust) } returns "api-key"
        every { appConfig.durableRunsEnabled } returns true
    }

    private fun event(id: Int, json: String) = "id: $id\ndata: $json\n\n"
    private val done = "data: [DONE]\n\n"

    private fun MockRequestHandleScope.json(body: String) =
        respond(body, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))

    private fun MockRequestHandleScope.sse(body: String) =
        respond(body, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "text/event-stream"))

    /**
     * An orchestrator whose durable runs go to a scripted retrieval-server:
     * POST /runs starts run_1, [stream] answers each GET /runs/run_1/stream
     * (by attempt, from 1) and GET /runs/run_1 reports [status].
     */
    private fun orchestrator(
        status: String,
        stream: MockRequestHandleScope.(attempt: Int) -> HttpResponseData
    ): GenerationOrchestrator {
        var attempts = 0
        val http = HttpClient(MockEngine { req: HttpRequestData ->
            when {
                req.method == HttpMethod.Post && req.url.encodedPath == "/runs" -> json("""{"run_id":"run_1"}""")
                req.url.encodedPath == "/runs/run_1/stream" -> stream(++attempts)
                req.method == HttpMethod.Get && req.url.encodedPath == "/runs/run_1" ->
                    json("""{"run_id":"run_1","status":"$status","last_seq":0}""")
                else -> error("unexpected ${req.method.value} ${req.url}")
            }
        }) { install(HttpTimeout) }
        val runsClient = RunsClient(
            KotlinLogging.logger("GenerationOrchestratorDurableRunTest"), provideJson(), http, "http://retrieval-server:5001",
            reattachBackoffMs = listOf(1L, 2L), reattachDeadlineMs = 250L
        )
        return GenerationOrchestrator(
            credentialsService, instructionService, conversationService, mockk(relaxed = true),
            mockk(relaxed = true), mockk(relaxed = true), mockk(relaxed = true), mockk(relaxed = true),
            mockk(relaxed = true), AppScope(), runsClient, appConfig, mockk(relaxed = true), ActiveTurns()
        )
    }

    private suspend fun GenerationOrchestrator.runTurn(): List<String> =
        processTextGenerateStreamRequest(aiConfig, "", "", "write a report", null, null, "REACT_APP", cust).flow.toList()

    private fun persistedAssistant(): Message {
        val persisted = mutableListOf<Message>()
        coVerify { conversationService.addMessageInConversation(capture(persisted)) }
        return persisted.single { it.role == "assistant" }
    }

    private fun errFrames(frames: List<String>) = frames.filter { it.startsWith("{\"t\":\"err\"") }

    @Test
    fun `a run that never ends past the deadline stores the error and emits err`() = runTest {
        val orchestrator = orchestrator(status = "PENDING") { attempt ->
            if (attempt == 1) sse(event(1, """{"content":"The report"}""") + done) else sse(done)
        }

        val frames = orchestrator.runTurn()

        assertEquals(listOf("{\"t\":\"err\",\"v\":\"$interrupted\"}\n"), errFrames(frames))
        val assistant = persistedAssistant()
        assertEquals("The report", assistant.text)
        assertEquals(interrupted, assistant.errorMessage)
        assertEquals("run_1", assistant.runId)
        // The run may still finish: it stays pending, so a reload can reattach.
        coVerify(exactly = 1) { conversationService.addPendingRun(cust, "conv-1", any()) }
        coVerify(exactly = 0) { conversationService.removePendingRun(any(), any(), any()) }
    }

    @Test
    fun `a lost run that streamed nothing is stored with its error and empty text`() = runTest {
        val orchestrator = orchestrator(status = "ENQUEUED") { sse(done) }

        val frames = orchestrator.runTurn()

        assertEquals(1, errFrames(frames).size)
        val assistant = persistedAssistant()
        assertEquals("", assistant.text)
        assertEquals(interrupted, assistant.errorMessage)
    }

    @Test
    fun `a failed run's standalone error row is the user-facing error, relayed once`() = runTest {
        val reason = "This response was interrupted by a server restart and could not be completed. Please try again."
        val orchestrator = orchestrator(status = "MAX_RECOVERY_ATTEMPTS_EXCEEDED") {
            sse(
                event(1, """{"content":"Half an answer"}""") +
                    event(2, """{"error":"$reason","error_type":"run_lost"}""") +
                    event(3, """{"status":"error","run_id":"run_1","error":"$reason","error_type":"run_lost"}""") +
                    done
            )
        }

        val frames = orchestrator.runTurn()

        assertEquals(listOf("{\"t\":\"err\",\"v\":\"$reason\"}\n"), errFrames(frames))
        val assistant = persistedAssistant()
        assertEquals("Half an answer", assistant.text)
        assertEquals(reason, assistant.errorMessage)
        // The terminal event arrived: the message first, then the pending run.
        coVerifyOrder {
            conversationService.addMessageInConversation(match { it.role == "assistant" })
            conversationService.removePendingRun(cust, "conv-1", PendingRun(assistant.messageId, "run_1", "OPENAI", "model-x"))
        }
    }

    @Test
    fun `a completed run stores its answer, then leaves the pending set`() = runTest {
        val orchestrator = orchestrator(status = "PENDING") {
            sse(
                event(1, """{"content":"All done."}""") +
                    event(2, """{"status":"completed","run_id":"run_1","generated_response":"All done.","generated_artifacts":[],"error":null}""") +
                    done
            )
        }

        val frames = orchestrator.runTurn()

        assertTrue(errFrames(frames).isEmpty(), frames.toString())
        val assistant = persistedAssistant()
        assertEquals("All done.", assistant.text)
        assertEquals(null, assistant.errorMessage)
        coVerifyOrder {
            conversationService.addMessageInConversation(match { it.role == "assistant" })
            conversationService.removePendingRun(cust, "conv-1", any())
        }
    }

    @Test
    fun `a lost run that DBOS reports ended leaves the pending set after its error is stored`() = runTest {
        // Pre-0.2 tail: the run errored without a terminal row, so every attempt ends with a bare [DONE].
        val orchestrator = orchestrator(status = "ERROR") { attempt ->
            if (attempt == 1) sse(event(1, """{"content":"partial"}""")) else sse(done)
        }

        val frames = orchestrator.runTurn()

        assertEquals(1, errFrames(frames).size)
        assertEquals(interrupted, persistedAssistant().errorMessage)
        coVerifyOrder {
            conversationService.addMessageInConversation(match { it.role == "assistant" })
            conversationService.removePendingRun(cust, "conv-1", any())
        }
    }
}
