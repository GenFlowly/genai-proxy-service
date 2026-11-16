package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.models.AIConfig
import com.genflowly.models.AIVendor
import com.genflowly.models.Message
import com.genflowly.models.api.InstructionResponse
import com.genflowly.models.retrieval.RetrievalResult
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.providers.RunsClient
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The math-delimiter guidance (ResponseFormatting) must decorate the system
 * prompt the VENDOR sees on UI turns — both generation paths — while the
 * persisted messages keep the raw instruction: the stored systemPrompt is the
 * record of the instruction applied, not of transport-level scaffolding.
 */
class GenerationOrchestratorSystemPromptTest {

    private val cust = "cust-1"
    private val instruction = "be kind"
    private val decorated = "$instruction\n\n${ResponseFormatting.MATH_FORMATTING_GUIDANCE}"
    private val aiConfig = listOf(AIConfig(aiVendor = AIVendor.OPENAI, model = "gpt-5-mini"))

    private val instructionService = mockk<InstructionService>(relaxed = true)
    private val conversationService = mockk<ConversationService>(relaxed = true)
    private val credentialsService = mockk<CustomerCredentialsService>()
    private val retrievalService = mockk<RetrievalServerClient>()
    private val runsClient = mockk<RunsClient>()

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
        runsClient,
        mockk(relaxed = true),          // conversationManagementService
        entitlementServiceWith()
    )

    init {
        coEvery { instructionService.getInstructionVersion(cust, "i1", 1) } returns InstructionResponse(
            id = "i1", version = 1, name = "Coach", instruction = instruction
        )
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
        every {
            retrievalService.retrieveAndGenerateStream(
                any(), any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any(), any(), any(), any(), any(), any(), any(),
                memoryContext = any(),
                entitlements = any()
            )
        } returns flowOf()
        coEvery {
            runsClient.startRun(
                customerId = any(), client = any(), query = any(), llmProvider = any(), llmModel = any(),
                llmMaxTokens = any(), conversationHistory = any(), systemPrompt = any(), agentic = any(),
                queryImages = any(), queryFiles = any(), tools = any(), toolChoice = any(),
                toolResults = any(), responseSchema = any(), memoryEnabled = any(), requestSource = any(),
                graphId = any(), thinkingLevel = any(), runId = any(),
                memoryContext = any(),
                entitlements = any()
            )
        } returns "run_1"
        every { runsClient.streamRun("run_1", any()) } returns flowOf()
    }

    @Test
    fun `UI turn sends instruction plus math guidance to the vendor and persists the raw instruction`() = runTest {
        orchestrator.processTextGenerateRequest(
            aiConfig, "i1", "1", "explain entropy", null, null, "REACT_APP", cust
        )

        coVerify {
            retrievalService.retrieveAndGenerate(
                customerId = any(), client = any(), query = any(), llmCredentials = any(),
                llmProvider = any(), llmModel = any(), llmMaxTokens = any(),
                conversationHistory = any(), systemPrompt = decorated, agentic = any(),
                queryImages = any(), tools = any(), toolChoice = any(), toolResults = any(),
                responseSchema = any(), memoryEnabled = any(), requestSource = any(), graphId = any(),
                memoryContext = any(),
                entitlements = any()
            )
        }

        val persisted = mutableListOf<Message>()
        coVerify { conversationService.addMessageInConversation(capture(persisted)) }
        assertTrue(persisted.size >= 2, "user + assistant messages persisted")
        persisted.forEach { assertEquals(instruction, it.systemPrompt) }
    }

    @Test
    fun `streamed UI turn starts a durable run with the decorated system prompt`() = runTest {
        val result = orchestrator.processTextGenerateStreamRequest(
            aiConfig, "i1", "1", "explain entropy", null, null, "REACT_APP", cust
        )
        // Drain the relay — completes once background generation finished.
        result.flow.toList()

        coVerify {
            runsClient.startRun(
                customerId = any(), client = any(), query = any(), llmProvider = any(), llmModel = any(),
                llmMaxTokens = any(), conversationHistory = any(), systemPrompt = decorated, agentic = true,
                queryImages = any(), queryFiles = any(), tools = any(), toolChoice = any(),
                toolResults = any(), responseSchema = any(), memoryEnabled = any(), requestSource = any(),
                graphId = any(), thinkingLevel = any(), runId = any(),
                memoryContext = any(),
                entitlements = any()
            )
        }
        verify(exactly = 0) {
            retrievalService.retrieveAndGenerateStream(
                any(), any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any(), any(), any(), any(), any(), any(), any(),
                memoryContext = any(),
                entitlements = any()
            )
        }
    }

    @Test
    fun `without durable runs the streamed turn falls back to the stateless stream`() = runTest {
        coEvery {
            runsClient.startRun(
                customerId = any(), client = any(), query = any(), llmProvider = any(), llmModel = any(),
                llmMaxTokens = any(), conversationHistory = any(), systemPrompt = any(), agentic = any(),
                queryImages = any(), queryFiles = any(), tools = any(), toolChoice = any(),
                toolResults = any(), responseSchema = any(), memoryEnabled = any(), requestSource = any(),
                graphId = any(), thinkingLevel = any(), runId = any(),
                memoryContext = any(),
                entitlements = any()
            )
        } returns null

        val result = orchestrator.processTextGenerateStreamRequest(
            aiConfig, "i1", "1", "explain entropy", null, null, "REACT_APP", cust
        )
        result.flow.toList()

        verify {
            retrievalService.retrieveAndGenerateStream(
                customerId = any(), client = any(), query = any(), llmCredentials = any(),
                llmProvider = any(), llmModel = any(), llmMaxTokens = any(),
                conversationHistory = any(), systemPrompt = decorated, agentic = any(),
                queryImages = any(), tools = any(), toolChoice = any(), toolResults = any(),
                responseSchema = any(), memoryEnabled = any(), requestSource = any(), graphId = any(),
                memoryContext = any(),
                entitlements = any()
            )
        }
    }

    @Test
    fun `non-UI client turn reaches the vendor unaltered`() = runTest {
        orchestrator.processTextGenerateRequest(
            aiConfig, "i1", "1", "explain entropy", null, null, "SOME_API_CLIENT", cust
        )

        coVerify {
            retrievalService.retrieveAndGenerate(
                customerId = any(), client = any(), query = any(), llmCredentials = any(),
                llmProvider = any(), llmModel = any(), llmMaxTokens = any(),
                conversationHistory = any(), systemPrompt = instruction, agentic = any(),
                queryImages = any(), tools = any(), toolChoice = any(), toolResults = any(),
                responseSchema = any(), memoryEnabled = any(), requestSource = any(), graphId = any(),
                memoryContext = any(),
                entitlements = any()
            )
        }
    }
}
