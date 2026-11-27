package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.models.AIConfig
import com.genflowly.models.AIVendor
import com.genflowly.models.Message
import com.genflowly.models.retrieval.STOP_REASON_INTERRUPTED
import com.genflowly.models.retrieval.StreamChunk
import com.genflowly.providers.RunsClient
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * A durable run whose stream is lost still leaves a reply behind: saved with
 * stop reason "interrupted" (even with no text) so the card can offer
 * Regenerate, and a run DBOS reran after a crash is saved from the rerun only.
 */
class GenerationInterruptedTest {

    private val cust = "cust-1"
    private val aiConfig = listOf(AIConfig(aiVendor = AIVendor.OPENAI, model = "gpt-5.4-nano"))
    private val firstAttempt = """{"v":2,"at":100,"type":"step.start","id":"n1:1","kind":"llm","node":"n1","name":"Response Generator"}"""
    private val rerun = """{"v":2,"at":40,"type":"step.start","id":"n1:1","kind":"llm","node":"n1","name":"Response Generator"}"""

    private val conversationService = mockk<ConversationService>(relaxed = true)
    private val runsClient = mockk<RunsClient>()

    private val orchestrator = GenerationOrchestrator(
        mockk(relaxed = true),          // credentialsService
        mockk(relaxed = true),          // instructionService
        conversationService,
        mockk(relaxed = true),          // retrievalService
        mockk(relaxed = true),          // requestValidator
        mockk(relaxed = true),          // modelCatalogService
        mockk(relaxed = true),          // memoryService
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
    }

    private fun generate(stream: Flow<StreamChunk>): Pair<Message, List<String>> = runBlocking {
        every { runsClient.streamRun("run_1", any()) } returns stream
        val result = orchestrator.processTextGenerateStreamRequest(
            aiConfig, "", "", "hi", "conv-1", null, "REACT_APP", cust
        )
        val frames = withTimeout(5_000) { result.flow.toList() }
        val saved = mutableListOf<Message>()
        coVerify { conversationService.addMessageInConversation(capture(saved)) }
        saved.single { it.role == "assistant" } to frames
    }

    @Test
    fun `a reply whose run was lost is saved empty and marked interrupted`() {
        val (reply, frames) = generate(flowOf(
            StreamChunk.Activity(firstAttempt),
            StreamChunk.StopReason(STOP_REASON_INTERRUPTED)
        ))

        assertEquals("", reply.text)
        assertEquals(STOP_REASON_INTERRUPTED, reply.stopReason)
        assertEquals("[$firstAttempt]", reply.activityJson)
        assertTrue(frames.any { it.contains("\"sr\"") && it.contains(STOP_REASON_INTERRUPTED) }, "frames: $frames")
    }

    @Test
    fun `a rerun after a crash replaces what the first attempt streamed`() {
        val (reply, frames) = generate(flowOf(
            StreamChunk.Activity(firstAttempt),
            StreamChunk.Content("Partial answ"),
            StreamChunk.Usage(10, 2, 12, 0),
            StreamChunk.RunRestarted,
            StreamChunk.Activity(rerun),
            StreamChunk.Content("Full answer"),
            StreamChunk.StopReason("stop")
        ))

        assertEquals("Full answer", reply.text)
        assertEquals("stop", reply.stopReason)
        assertEquals("[$rerun]", reply.activityJson)
        assertEquals(null, reply.inputTokens)
        assertTrue(frames.contains("{\"t\":\"cr\"}\n"), "the client clears the abandoned text: $frames")
    }
}
