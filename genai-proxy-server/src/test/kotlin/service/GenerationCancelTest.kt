package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.models.AIConfig
import com.genflowly.models.AIVendor
import com.genflowly.models.Message
import com.genflowly.models.retrieval.StreamChunk
import com.genflowly.providers.RunsClient
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Stop freezes a reply where it is: the server keeps the stopped message even
 * when no answer text streamed yet, marked "cancelled", and answers the Stop
 * without waiting on the retrieval-server's durable-run cancel.
 */
class GenerationCancelTest {

    private val cust = "cust-1"
    private val aiConfig = listOf(AIConfig(aiVendor = AIVendor.OPENAI, model = "gpt-5.4-nano"))
    private val activityEvent = """{"v":2,"at":120,"type":"step.start","id":"n1:1","kind":"llm","node":"n1","name":"Response Generator"}"""

    private val conversationService = mockk<ConversationService>(relaxed = true)
    private val credentialsService = mockk<CustomerCredentialsService>(relaxed = true)
    private val runsClient = mockk<RunsClient>()
    private val memoryService = mockk<MemoryService>(relaxed = true)
    private val stepRelayed = CompletableDeferred<Unit>()

    private val orchestrator = GenerationOrchestrator(
        credentialsService,
        mockk(relaxed = true),          // instructionService
        conversationService,
        mockk(relaxed = true),          // retrievalService
        mockk(relaxed = true),          // requestValidator
        mockk(relaxed = true),          // modelCatalogService
        memoryService,
        mockk(relaxed = true),          // costCalculationService
        mockk(relaxed = true),          // graphRepository
        AppScope(),
        runsClient,
        mockk(relaxed = true),          // conversationManagementService
        entitlementServiceWith()
    )

    init {
        coEvery { conversationService.resolveWritableConversationId(cust, any(), any(), any(), any()) } returns "conv-1"
        coEvery { conversationService.findActiveTurnUserMessage(any(), any(), any(), any()) } returns null
        coEvery {
            runsClient.startRun(
                customerId = any(), client = any(), query = any(), llmProvider = any(), llmModel = any(),
                llmMaxTokens = any(), conversationHistory = any(), systemPrompt = any(), agentic = any(),
                queryImages = any(), queryFiles = any(), tools = any(), toolChoice = any(),
                toolResults = any(), responseSchema = any(), memoryEnabled = any(), requestSource = any(),
                graphId = any(), thinkingLevel = any(), runId = any(),
                memoryContext = any(),
                entitlements = any(),
                turnId = any()
            )
        } returns "run_1"
        every { runsClient.streamRun("run_1", any()) } returns flow {
            emit(StreamChunk.Activity(activityEvent))
            stepRelayed.complete(Unit)
            awaitCancellation()
        }
        // A retrieval-server that never answers the cancel.
        coEvery { runsClient.cancelRun("run_1") } coAnswers { awaitCancellation() }
    }

    @Test
    fun `a reply stopped while thinking is saved empty, marked cancelled, with its activity log`() = runBlocking {
        coEvery { runsClient.cancelRun("run_1") } returns true
        val result = orchestrator.processTextGenerateStreamRequest(
            aiConfig, "", "", "hi", "conv-1", null, "REACT_APP", cust, clientGenerationId = "gen-1"
        )
        val frames = async { result.flow.toList() }
        withTimeout(5_000) { stepRelayed.await() }

        assertTrue(withTimeout(1_000) { orchestrator.cancelGeneration(cust, "gen-1") })
        val relayed = withTimeout(5_000) { frames.await() }

        val saved = mutableListOf<Message>()
        coVerify { conversationService.addMessageInConversation(capture(saved)) }
        val reply = saved.single { it.role == "assistant" }
        assertEquals(result.responseMessageId, reply.messageId)
        assertEquals("", reply.text)
        assertEquals("cancelled", reply.stopReason)
        assertEquals("[$activityEvent]", reply.activityJson)
        assertTrue(relayed.last().contains("\"cancelled\""), "terminal frame: ${relayed.last()}")
    }

    @Test
    fun `Stop returns without waiting on the durable run's cancel`() = runBlocking {
        val result = orchestrator.processTextGenerateStreamRequest(
            aiConfig, "", "", "hi", "conv-1", null, "REACT_APP", cust, clientGenerationId = "gen-2"
        )
        val firstFrame = async { result.flow.first() }
        withTimeout(5_000) { stepRelayed.await() }

        val cancelled = withTimeout(1_000) { orchestrator.cancelGeneration(cust, "gen-2") }

        assertTrue(cancelled)
        coVerify(timeout = 5_000) { runsClient.cancelRun("run_1") }
        firstFrame.cancel()
    }
}
