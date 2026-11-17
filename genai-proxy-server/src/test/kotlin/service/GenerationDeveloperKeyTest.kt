package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.models.AIConfig
import com.genflowly.models.AIVendor
import com.genflowly.models.Message
import com.genflowly.models.retrieval.RetrievalResult
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.providers.RunsClient
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * A turn requested with a developer API key carries that key's id on both of
 * its messages, so the usage rollup can attribute the reply's cost to the key.
 */
class GenerationDeveloperKeyTest {

    private val cust = "cust-1"
    private val aiConfig = listOf(AIConfig(aiVendor = AIVendor.OPENAI, model = "gpt-5.4-nano"))

    private val conversationService = mockk<ConversationService>(relaxed = true)
    private val credentialsService = mockk<CustomerCredentialsService>()
    private val retrievalService = mockk<RetrievalServerClient>()
    private val runsClient = mockk<RunsClient>()
    private val memoryService = mockk<MemoryService>()

    private val orchestrator = GenerationOrchestrator(
        credentialsService,
        mockk(relaxed = true),
        conversationService,
        retrievalService,
        mockk(relaxed = true),
        mockk(relaxed = true),
        memoryService,
        mockk(relaxed = true),
        mockk(relaxed = true),
        AppScope(),
        runsClient,
        mockk(relaxed = true),
        entitlementServiceWith()
    )

    init {
        coEvery { memoryService.getMemorySettings(cust) } returns
            MemorySettings(learnFromChats = false, learnFromNotes = false, useInReplies = false)
        coEvery { conversationService.resolveWritableConversationId(cust, any(), any(), any(), any()) } returns "conv-1"
        coEvery { credentialsService.getCustomerApiKeyForVendor(any(), cust) } returns "api-key"
        coEvery {
            retrievalService.retrieveAndGenerate(
                any(), any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any(), any(), any(), any(), any(), any(), any(),
                memoryContext = any(),
                entitlements = any()
            )
        } returns RetrievalResult("ok", 1, 2, 3, null)
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
        every { runsClient.streamRun("run_1", any()) } returns flowOf()
    }

    private fun persisted(): List<Message> {
        val saved = mutableListOf<Message>()
        coVerify { conversationService.addMessageInConversation(capture(saved)) }
        return saved
    }

    @Test
    fun `a batch turn from an api key stamps the key on the question and the reply`() = runTest {
        orchestrator.processTextGenerateRequest(
            aiConfig, "", "", "hi", null, null, "API", cust, developerKeyId = "KEY-1"
        )

        val saved = persisted()
        assertEquals(setOf("user", "assistant"), saved.map { it.role }.toSet())
        assertEquals(listOf("KEY-1", "KEY-1"), saved.map { it.developerKeyId })
    }

    @Test
    fun `a streamed turn from an api key stamps the key on the question`() = runTest {
        orchestrator.processTextGenerateStreamRequest(
            aiConfig, "", "", "hi", null, null, "API", cust, developerKeyId = "KEY-1"
        )

        assertEquals("KEY-1", persisted().single { it.role == "user" }.developerKeyId)
    }

    @Test
    fun `an app turn carries no key`() = runTest {
        orchestrator.processTextGenerateRequest(aiConfig, "", "", "hi", null, null, "REACT_APP", cust)

        assertEquals(listOf(null, null), persisted().map { it.developerKeyId })
    }
}
