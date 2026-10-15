package com.genflowly.service

import com.genflowly.config.AppConfig
import com.genflowly.di.AppScope
import com.genflowly.models.AIConfig
import com.genflowly.models.AIVendor
import com.genflowly.models.AttachmentRef
import com.genflowly.models.api.InstructionResponse
import com.genflowly.models.retrieval.FileOrigin
import com.genflowly.models.retrieval.FileRef
import com.genflowly.models.retrieval.ImageRef
import com.genflowly.models.retrieval.RetrievalResult
import com.genflowly.models.retrieval.StreamChunk
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.providers.RunsClient
import com.genflowly.models.Message
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import io.mockk.verify
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * What the orchestrator puts into the retrieval request for the current turn,
 * on the streaming and the non-streaming path.
 */
class GenerationOrchestratorRequestTest {

    private val cust = "cust-1"
    private val aiConfig = listOf(AIConfig(aiVendor = AIVendor.OPENAI, model = "model-x"))

    private val photo = AttachmentRef("img-1", "customers/cust-1/attachments/img-1", "image/png")
    private val brief = AttachmentRef(
        "up-1", "customers/cust-1/attachments/up-1", "application/pdf", filename = "Brief.pdf", sizeBytes = 2_048L
    )

    private val instructionService = mockk<InstructionService>(relaxed = true)
    private val conversationService = mockk<ConversationService>(relaxed = true)
    private val credentialsService = mockk<CustomerCredentialsService>()
    private val retrievalService = mockk<RetrievalServerClient>()
    private val runsClient = mockk<RunsClient>(relaxed = true)
    private val appConfig = mockk<AppConfig>(relaxed = true)  // durableRunsEnabled=false: stateless path

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
        appConfig,
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
        } returns flowOf(StreamChunk.Content("ok"))
        coEvery {
            retrievalService.retrieveAndGenerate(
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any()
            )
        } returns RetrievalResult("ok", 1, 2, 3, null)
    }

    private val uploadedBrief = listOf(
        FileRef("up-1", "customers/cust-1/attachments/up-1", "application/pdf", "Brief.pdf", 2_048L, FileOrigin.UPLOADED)
    )

    @Test
    fun `a streamed turn sends its documents as uploaded files and its images as images`() = runTest {
        orchestrator.processTextGenerateStreamRequest(
            aiConfig, "", "", "summarise these", null, null, "REACT_APP", cust,
            attachments = listOf(photo, brief)
        ).flow.toList()

        verify {
            retrievalService.retrieveAndGenerateStream(
                customerId = any(), client = any(), query = any(), llmCredentials = any(),
                llmProvider = any(), llmModel = any(), llmMaxTokens = any(),
                conversationHistory = any(), systemPrompt = any(), agentic = any(),
                queryImages = listOf(ImageRef("customers/cust-1/attachments/img-1", "image/png")),
                tools = any(), toolChoice = any(), toolResults = any(),
                responseSchema = any(), memoryEnabled = any(), requestSource = any(), graphId = any(),
                thinkingLevel = any(), queryFiles = uploadedBrief, locale = any(), fsNamespace = any()
            )
        }
    }

    // ── Locale (6.1) ────────────────────────────────────────────────────────

    @Test
    fun `the locale reaches the stateless stream request`() = runTest {
        orchestrator.processTextGenerateStreamRequest(
            aiConfig, "", "", "hi", null, null, "REACT_APP", cust, locale = "en-US"
        ).flow.toList()

        verify {
            retrievalService.retrieveAndGenerateStream(
                customerId = any(), client = any(), query = any(), llmCredentials = any(),
                llmProvider = any(), llmModel = any(), llmMaxTokens = any(),
                conversationHistory = any(), systemPrompt = any(), agentic = any(),
                queryImages = any(), tools = any(), toolChoice = any(), toolResults = any(),
                responseSchema = any(), memoryEnabled = any(), requestSource = any(), graphId = any(),
                thinkingLevel = any(), queryFiles = any(), locale = "en-US", fsNamespace = any()
            )
        }
    }

    @Test
    fun `the locale reaches the non-streamed request`() = runTest {
        orchestrator.processTextGenerateRequest(
            aiConfig, "", "", "hi", null, null, "REACT_APP", cust, locale = "de-DE"
        )

        coVerify {
            retrievalService.retrieveAndGenerate(
                customerId = any(), client = any(), query = any(), llmCredentials = any(),
                llmProvider = any(), llmModel = any(), llmMaxTokens = any(),
                conversationHistory = any(), systemPrompt = any(), agentic = any(),
                queryImages = any(), tools = any(), toolChoice = any(), toolResults = any(),
                responseSchema = any(), memoryEnabled = any(), requestSource = any(), graphId = any(),
                thinkingLevel = any(), queryFiles = any(), locale = "de-DE", fsNamespace = any()
            )
        }
    }

    @Test
    fun `the locale and files reach the durable run start`() = runTest {
        every { appConfig.durableRunsEnabled } returns true
        coEvery {
            runsClient.startRun(
                customerId = any(), client = any(), query = any(), llmProvider = any(), llmModel = any(),
                llmMaxTokens = any(), conversationHistory = any(), systemPrompt = any(), agentic = any(),
                queryImages = any(), tools = any(), toolChoice = any(), toolResults = any(),
                responseSchema = any(), memoryEnabled = any(), requestSource = any(), graphId = any(),
                thinkingLevel = any(), queryFiles = any(), locale = any(), fsNamespace = any()
            )
        } returns "run_1"
        every { runsClient.streamRun("run_1", any()) } returns flowOf(StreamChunk.Content("ok"))

        orchestrator.processTextGenerateStreamRequest(
            aiConfig, "", "", "summarise these", null, null, "REACT_APP", cust,
            attachments = listOf(photo, brief), locale = "fr-CA"
        ).flow.toList()

        coVerify {
            runsClient.startRun(
                customerId = cust, client = any(), query = any(), llmProvider = any(), llmModel = any(),
                llmMaxTokens = any(), conversationHistory = any(), systemPrompt = any(), agentic = any(),
                queryImages = any(), tools = any(), toolChoice = any(), toolResults = any(),
                responseSchema = any(), memoryEnabled = any(), requestSource = any(), graphId = any(),
                thinkingLevel = any(), queryFiles = uploadedBrief, locale = "fr-CA", fsNamespace = any()
            )
        }
    }

    // ── Scratch namespace and run id (1.16) ─────────────────────────────────

    private val namespacePattern = Regex("^[0-9a-f]{32}$")

    private fun persistedAssistantMessages(): List<Message> {
        val persisted = mutableListOf<Message>()
        coVerify { conversationService.addMessageInConversation(capture(persisted)) }
        return persisted.filter { it.role == "assistant" }
    }

    private fun stubDurableStart(runId: String?) {
        every { appConfig.durableRunsEnabled } returns true
        coEvery {
            runsClient.startRun(
                customerId = any(), client = any(), query = any(), llmProvider = any(), llmModel = any(),
                llmMaxTokens = any(), conversationHistory = any(), systemPrompt = any(), agentic = any(),
                queryImages = any(), tools = any(), toolChoice = any(), toolResults = any(),
                responseSchema = any(), memoryEnabled = any(), requestSource = any(), graphId = any(),
                thinkingLevel = any(), queryFiles = any(), locale = any(), fsNamespace = any()
            )
        } returns runId
        if (runId != null) every { runsClient.streamRun(runId, any()) } returns flowOf(StreamChunk.Content("ok"))
    }

    private fun sentToStatelessStream(): String {
        val sent = slot<String>()
        verify {
            retrievalService.retrieveAndGenerateStream(
                customerId = any(), client = any(), query = any(), llmCredentials = any(),
                llmProvider = any(), llmModel = any(), llmMaxTokens = any(),
                conversationHistory = any(), systemPrompt = any(), agentic = any(),
                queryImages = any(), tools = any(), toolChoice = any(), toolResults = any(),
                responseSchema = any(), memoryEnabled = any(), requestSource = any(), graphId = any(),
                thinkingLevel = any(), queryFiles = any(), locale = any(), fsNamespace = capture(sent)
            )
        }
        return sent.captured
    }

    private fun sentToDurableStart(): String {
        val sent = slot<String>()
        coVerify {
            runsClient.startRun(
                customerId = any(), client = any(), query = any(), llmProvider = any(), llmModel = any(),
                llmMaxTokens = any(), conversationHistory = any(), systemPrompt = any(), agentic = any(),
                queryImages = any(), tools = any(), toolChoice = any(), toolResults = any(),
                responseSchema = any(), memoryEnabled = any(), requestSource = any(), graphId = any(),
                thinkingLevel = any(), queryFiles = any(), locale = any(), fsNamespace = capture(sent)
            )
        }
        return sent.captured
    }

    @Test
    fun `a streamed turn sends a fresh namespace and records it on the persisted message`() = runTest {
        orchestrator.processTextGenerateStreamRequest(aiConfig, "", "", "hi", null, null, "REACT_APP", cust).flow.toList()

        val sent = sentToStatelessStream()
        assertTrue(namespacePattern.matches(sent), sent)
        val assistant = persistedAssistantMessages().single()
        assertEquals(sent, assistant.fsNamespace)
        assertNull(assistant.runId, "the stateless path has no durable run")
    }

    @Test
    fun `a durable turn records its run id and namespace on the persisted message`() = runTest {
        stubDurableStart("run_1")

        orchestrator.processTextGenerateStreamRequest(aiConfig, "", "", "hi", null, null, "REACT_APP", cust).flow.toList()

        val sent = sentToDurableStart()
        assertTrue(namespacePattern.matches(sent), sent)
        val assistant = persistedAssistantMessages().single()
        assertEquals(sent, assistant.fsNamespace)
        assertEquals("run_1", assistant.runId)
    }

    @Test
    fun `a failed durable start falls back to the stateless stream with a fresh namespace`() = runTest {
        stubDurableStart(null)

        orchestrator.processTextGenerateStreamRequest(aiConfig, "", "", "hi", null, null, "REACT_APP", cust).flow.toList()

        val toRun = sentToDurableStart()
        val toStream = sentToStatelessStream()
        assertNotEquals(toRun, toStream)
        val assistant = persistedAssistantMessages().single()
        assertEquals(toStream, assistant.fsNamespace)
        assertNull(assistant.runId)
    }

    @Test
    fun `every vendor of a non-streamed turn gets its own namespace, recorded on its reply`() = runTest {
        val twoVendors = listOf(
            AIConfig(aiVendor = AIVendor.OPENAI, model = "model-x"),
            AIConfig(aiVendor = AIVendor.CLAUDE, model = "model-y")
        )

        val replies = orchestrator.processTextGenerateRequest(twoVendors, "", "", "hi", null, null, "REACT_APP", cust)

        val sent = mutableListOf<String?>()
        coVerify(exactly = 2) {
            retrievalService.retrieveAndGenerate(
                customerId = any(), client = any(), query = any(), llmCredentials = any(),
                llmProvider = any(), llmModel = any(), llmMaxTokens = any(),
                conversationHistory = any(), systemPrompt = any(), agentic = any(),
                queryImages = any(), tools = any(), toolChoice = any(), toolResults = any(),
                responseSchema = any(), memoryEnabled = any(), requestSource = any(), graphId = any(),
                thinkingLevel = any(), queryFiles = any(), locale = any(), fsNamespace = captureNullable(sent)
            )
        }
        assertEquals(2, sent.toSet().size, "one namespace per vendor")
        sent.forEach { assertTrue(namespacePattern.matches(it!!), it) }
        assertEquals(sent.toSet(), replies.map { it.fsNamespace }.toSet())
        assertEquals(sent.toSet(), persistedAssistantMessages().map { it.fsNamespace }.toSet())
    }

    @Test
    fun `a non-streamed turn sends its documents as uploaded files`() = runTest {
        orchestrator.processTextGenerateRequest(
            aiConfig, "", "", "summarise these", null, null, "REACT_APP", cust,
            attachments = listOf(photo, brief)
        )

        coVerify {
            retrievalService.retrieveAndGenerate(
                customerId = any(), client = any(), query = any(), llmCredentials = any(),
                llmProvider = any(), llmModel = any(), llmMaxTokens = any(),
                conversationHistory = any(), systemPrompt = any(), agentic = any(),
                queryImages = listOf(ImageRef("customers/cust-1/attachments/img-1", "image/png")),
                tools = any(), toolChoice = any(), toolResults = any(),
                responseSchema = any(), memoryEnabled = any(), requestSource = any(), graphId = any(),
                thinkingLevel = any(), queryFiles = uploadedBrief, locale = any(), fsNamespace = any()
            )
        }
    }
}
