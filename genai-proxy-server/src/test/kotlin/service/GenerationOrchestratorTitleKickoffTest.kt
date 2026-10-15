package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.models.api.InstructionResponse
import io.mockk.coEvery
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.test.runTest
import kotlin.test.Test

/**
 * The server-side title kickoff must fire exactly once — for a brand-new UI
 * conversation with a real prompt — and never for existing conversations
 * (multi-vendor sibling streams), tool continuations (blank prompt), or
 * non-UI clients (developer API-key traffic keeps titles opt-in).
 *
 * Calls processTextGenerateStreamRequest with an EMPTY aiConfig list: that
 * exercises the whole setup path (validation, instruction resolution,
 * conversation creation, the kickoff) and early-returns before any vendor
 * plumbing, so no credential/stream mocking is needed.
 */
class GenerationOrchestratorTitleKickoffTest {

    private val cust = "cust-1"
    private val prompt = "hello there"

    private val instructionService = mockk<InstructionService>(relaxed = true)
    private val conversationService = mockk<ConversationService>(relaxed = true)
    private val managementService = mockk<ConversationManagementService>(relaxed = true)

    private val orchestrator = GenerationOrchestrator(
        mockk(relaxed = true),          // customerCredentialsService
        instructionService,
        conversationService,
        mockk(relaxed = true),          // retrievalService
        mockk(relaxed = true),          // requestValidator
        mockk(relaxed = true),          // modelCatalogService
        mockk(relaxed = true),          // memoryService
        mockk(relaxed = true),          // costCalculationService
        mockk(relaxed = true),          // graphRepository
        AppScope(),
        mockk(relaxed = true),          // runsClient
        mockk(relaxed = true),          // appConfig
        managementService,
        ActiveTurns()
    )

    init {
        coEvery { instructionService.resolveDefaultInstruction(cust) } returns InstructionResponse(
            id = "i1", version = 1, name = "Coach", instruction = "be kind"
        )
        coEvery {
            conversationService.resolveWritableConversationId(cust, any(), any())
        } answers { thirdArg<String?>().takeUnless { it.isNullOrBlank() } ?: "conv-new" }
        coEvery { conversationService.findActiveTurnUserMessage(any(), any(), any(), any()) } returns null
        coEvery { conversationService.getLatestMessageId(any()) } returns "prev-1"
    }

    private suspend fun run(conversationId: String?, prompt: String, client: String) {
        orchestrator.processTextGenerateStreamRequest(
            emptyList(), "", "", prompt, conversationId, null, client, cust
        )
    }

    @Test
    fun `new UI conversation kicks off title generation with the resolved instruction name`() = runTest {
        run(conversationId = null, prompt = prompt, client = "REACT_APP")

        verify(exactly = 1) {
            managementService.launchTitleGenerationAsync("conv-new", cust, prompt, "Coach")
        }
    }

    @Test
    fun `existing conversation does not kick off title generation`() = runTest {
        run(conversationId = "conv-exist", prompt = prompt, client = "REACT_APP")

        verify(exactly = 0) { managementService.launchTitleGenerationAsync(any(), any(), any(), any()) }
    }

    @Test
    fun `blank prompt (tool continuation) does not kick off title generation`() = runTest {
        run(conversationId = null, prompt = "", client = "REACT_APP")

        verify(exactly = 0) { managementService.launchTitleGenerationAsync(any(), any(), any(), any()) }
    }

    @Test
    fun `non-UI client does not kick off title generation`() = runTest {
        run(conversationId = null, prompt = prompt, client = "SOME_API_CLIENT")

        verify(exactly = 0) { managementService.launchTitleGenerationAsync(any(), any(), any(), any()) }
    }
}
