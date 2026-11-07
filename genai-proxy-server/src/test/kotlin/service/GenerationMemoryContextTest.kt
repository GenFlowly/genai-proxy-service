package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.models.AIConfig
import com.genflowly.models.AIVendor
import com.genflowly.models.Message
import com.genflowly.models.retrieval.RetrievalResult
import com.genflowly.providers.MemoryContext
import com.genflowly.providers.RetrievalServerClient
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
import kotlin.test.assertNull

/**
 * Generation tells the MEMORY node where the conversation is and which reply
 * it is for: the project scopes which memories apply, and the reply id keys
 * the usage log. The project is the conversation's own, and only for its owner.
 */
class GenerationMemoryContextTest {

    private val cust = "cust-1"
    private val aiConfig = listOf(AIConfig(aiVendor = AIVendor.OPENAI, model = "gpt-5-mini"))

    private val conversationService = mockk<ConversationService>(relaxed = true)
    private val credentialsService = mockk<CustomerCredentialsService>()
    private val retrievalService = mockk<RetrievalServerClient>()
    private val memoryService = mockk<MemoryService>()

    private val orchestrator = GenerationOrchestrator(
        credentialsService,
        mockk(relaxed = true),          // instructionService
        conversationService,
        retrievalService,
        mockk(relaxed = true),          // requestValidator
        mockk(relaxed = true),          // modelCatalogService
        memoryService,
        mockk(relaxed = true),          // costCalculationService
        mockk(relaxed = true),          // graphRepository
        AppScope(),
        mockk(relaxed = true),          // runsClient
        mockk(relaxed = true),          // appConfig (durableRunsEnabled=false → stateless path)
        mockk(relaxed = true),          // conversationManagementService
        entitlementServiceWith()
    )

    private val context = slot<MemoryContext>()

    init {
        coEvery { memoryService.getMemorySettings(cust) } returns
            MemorySettings(learnFromChats = true, learnFromNotes = true, useInReplies = true)
        coEvery { conversationService.resolveWritableConversationId(cust, any(), any(), any()) } returns "conv-1"
        coEvery { conversationService.getOwnedConversationProjectId("conv-1", cust) } returns "PRJ1"
        coEvery { credentialsService.getCustomerApiKeyForVendor(any(), cust) } returns "api-key"
        coEvery {
            retrievalService.retrieveAndGenerate(
                any(), any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any(), any(), any(), any(), any(), any(), any(),
                memoryContext = capture(context),
                entitlements = any()
            )
        } returns RetrievalResult("ok", 1, 2, 3, null)
        every {
            retrievalService.retrieveAndGenerateStream(
                any(), any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any(), any(), any(), any(), any(), any(), any(),
                memoryContext = capture(context),
                entitlements = any()
            )
        } returns flowOf()
    }

    @Test
    fun `a batch reply names its project and the reply it will be saved as`() = runTest {
        val replies = orchestrator.processTextGenerateRequest(aiConfig, "", "", "hi", "conv-1", null, "REACT_APP", cust)

        assertEquals("PRJ1", context.captured.project_id)
        assertEquals("conv-1", context.captured.conversation_id)
        assertEquals(replies.single().messageId, context.captured.response_message_id)
        val persisted = mutableListOf<Message>()
        coVerify { conversationService.addMessageInConversation(capture(persisted)) }
        assertEquals(context.captured.response_message_id, persisted.single { it.role == "assistant" }.messageId)
    }

    @Test
    fun `a streamed reply names its project and its reply id`() = runTest {
        val result = orchestrator.processTextGenerateStreamRequest(aiConfig, "", "", "hi", "conv-1", null, "REACT_APP", cust)
        result.flow.toList()

        assertEquals("PRJ1", context.captured.project_id)
        assertEquals(result.responseMessageId, context.captured.response_message_id)
    }

    @Test
    fun `batch and streamed replies send the customer's entitlements`() = runTest {
        orchestrator.processTextGenerateRequest(aiConfig, "", "", "hi", "conv-1", null, "REACT_APP", cust)
        orchestrator.processTextGenerateStreamRequest(aiConfig, "", "", "hi", "conv-1", null, "REACT_APP", cust)
            .flow.toList()

        coVerify {
            retrievalService.retrieveAndGenerate(
                any(), any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any(), any(), any(), any(), any(), any(), any(),
                memoryContext = any(),
                entitlements = ALL_ENTITLEMENTS
            )
        }
        verify {
            retrievalService.retrieveAndGenerateStream(
                any(), any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any(), any(), any(), any(), any(), any(), any(),
                memoryContext = any(),
                entitlements = ALL_ENTITLEMENTS
            )
        }
    }

    @Test
    fun `a conversation the requester doesn't own applies Profile memories only`() = runTest {
        coEvery { conversationService.getOwnedConversationProjectId("conv-1", cust) } returns null

        orchestrator.processTextGenerateRequest(aiConfig, "", "", "hi", "conv-1", null, "REACT_APP", cust)

        assertNull(context.captured.project_id)
    }

    @Test
    fun `with memory off the project is not looked up`() = runTest {
        coEvery { memoryService.getMemorySettings(cust) } returns MemorySettings.OFF

        orchestrator.processTextGenerateRequest(aiConfig, "", "", "hi", "conv-1", null, "REACT_APP", cust)

        coVerify(exactly = 0) { conversationService.getOwnedConversationProjectId(any(), any()) }
    }
}
