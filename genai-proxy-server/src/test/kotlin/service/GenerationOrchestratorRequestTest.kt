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
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlin.test.Test

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
        mockk(relaxed = true)           // conversationManagementService
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
