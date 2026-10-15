package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.di.provideJson
import com.genflowly.models.AIConfig
import com.genflowly.models.AIVendor
import com.genflowly.models.Message
import com.genflowly.models.api.InstructionResponse
import com.genflowly.models.retrieval.StreamChunk
import com.genflowly.providers.RetrievalServerClient
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.HttpTimeout
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import mu.KotlinLogging
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Progress events are relayed to the client as "pg" frames, in stream order,
 * but are never captured: the persisted assistant message's thinking steps and
 * text are exactly what they would be without them. Retrieval keepalives are
 * neither relayed nor captured.
 */
class GenerationOrchestratorProgressTest {

    private val cust = "cust-1"
    private val aiConfig = listOf(AIConfig(aiVendor = AIVendor.OPENAI, model = "model-x"))

    private val stepRunning = """{"node":"tools","name":"Tools","kind":"tool","status":"running"}"""
    private val stepDone = """{"node":"tools","name":"Tools","kind":"tool","status":"done"}"""
    private val progress1 = """{"tool":"generate_pdf","chars":4000}"""
    private val progress2 = """{"tool":"generate_pdf","chars":9000}"""

    private val instructionService = mockk<InstructionService>(relaxed = true)
    private val conversationService = mockk<ConversationService>(relaxed = true)
    private val credentialsService = mockk<CustomerCredentialsService>()
    private val retrievalService = mockk<RetrievalServerClient>()

    private val orchestrator = GenerationOrchestrator(
        credentialsService,
        instructionService,
        conversationService,
        retrievalService,
        mockk(relaxed = true),          // requestValidator
        mockk(relaxed = true),          // modelCatalogService
        mockk(relaxed = true),          // memoryService
        mockk(relaxed = true),          // costCalculationService
        mockk(relaxed = true),          // graphRepository
        AppScope(),
        mockk(relaxed = true),          // runsClient
        mockk(relaxed = true),          // appConfig (durableRunsEnabled=false: stateless path)
        mockk(relaxed = true),          // conversationManagementService
        ActiveTurns()
    )

    init {
        coEvery { instructionService.resolveDefaultInstruction(cust) } returns InstructionResponse(
            id = "i1", version = 1, name = "Coach", instruction = "be kind"
        )
        coEvery { conversationService.resolveWritableConversationId(cust, any(), any(), any()) } returns "conv-1"
        coEvery { credentialsService.getCustomerApiKeyForVendor(any(), cust) } returns "api-key"
        every {
            retrievalService.retrieveAndGenerateStream(
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any()
            )
        } returns flowOf(
            StreamChunk.ThinkingStep(stepRunning),
            StreamChunk.Progress(progress1),
            StreamChunk.Progress(progress2),
            StreamChunk.ThinkingStep(stepDone),
            StreamChunk.Content("Your report is attached."),
            StreamChunk.Usage(10, 20, 30, 0)
        )
    }

    @Test
    fun `progress frames are relayed and the persisted thinking steps are unchanged`() = runTest {
        val result = orchestrator.processTextGenerateStreamRequest(
            aiConfig, "", "", "write a report", null, null, "REACT_APP", cust
        )
        // Drain the relay; it completes once the assistant message is persisted.
        val frames = result.flow.toList()

        assertEquals(
            listOf(
                "{\"t\":\"ks\",\"v\":$stepRunning}\n",
                "{\"t\":\"pg\",\"v\":$progress1}\n",
                "{\"t\":\"pg\",\"v\":$progress2}\n",
                "{\"t\":\"ks\",\"v\":$stepDone}\n",
                "{\"t\":\"c\",\"v\":\"Your report is attached.\"}\n"
            ),
            frames
        )

        val persisted = mutableListOf<Message>()
        coVerify { conversationService.addMessageInConversation(capture(persisted)) }
        val assistant = persisted.single { it.role == "assistant" }
        assertEquals("[$stepRunning,$stepDone]", assistant.thinkingStepsJson)
        assertEquals("Your report is attached.", assistant.text)
    }

    @Test
    fun `retrieval keepalives are neither relayed nor stored`() = runTest {
        val keepalive = "data: {\"keepalive\": true}\n\n"
        val sse = keepalive +
            "data: {\"thinking_step\": $stepRunning}\n\n" + keepalive + keepalive +
            "data: {\"thinking_step\": $stepDone}\n\n" + keepalive +
            "data: {\"content\": \"Your report is attached.\"}\n\n" + keepalive +
            "data: [DONE]\n\n"
        val retrieval = RetrievalServerClient(
            KotlinLogging.logger("GenerationOrchestratorProgressTest"), provideJson(),
            HttpClient(MockEngine {
                respond(sse, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "text/event-stream"))
            }) { install(HttpTimeout) },
            "http://retrieval-server:5001"
        )
        val conversations = mockk<ConversationService>(relaxed = true)
        coEvery { conversations.resolveWritableConversationId(cust, any(), any(), any()) } returns "conv-1"
        val orchestrator = GenerationOrchestrator(
            credentialsService, instructionService, conversations, retrieval,
            mockk(relaxed = true), mockk(relaxed = true), mockk(relaxed = true), mockk(relaxed = true),
            mockk(relaxed = true), AppScope(), mockk(relaxed = true), mockk(relaxed = true), mockk(relaxed = true),
            ActiveTurns()
        )

        val frames = orchestrator.processTextGenerateStreamRequest(
            aiConfig, "", "", "write a report", null, null, "REACT_APP", cust
        ).flow.toList()

        assertEquals(
            listOf(
                "{\"t\":\"ks\",\"v\":$stepRunning}\n",
                "{\"t\":\"ks\",\"v\":$stepDone}\n",
                "{\"t\":\"c\",\"v\":\"Your report is attached.\"}\n"
            ),
            frames
        )
        val persisted = mutableListOf<Message>()
        coVerify { conversations.addMessageInConversation(capture(persisted)) }
        val assistant = persisted.single { it.role == "assistant" }
        assertEquals("[$stepRunning,$stepDone]", assistant.thinkingStepsJson)
        assertEquals("Your report is attached.", assistant.text)
    }
}
