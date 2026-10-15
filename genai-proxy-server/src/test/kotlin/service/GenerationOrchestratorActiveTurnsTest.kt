package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.models.AIConfig
import com.genflowly.models.AIVendor
import com.genflowly.models.Message
import com.genflowly.models.api.InstructionResponse
import com.genflowly.models.retrieval.RetrievalResult
import com.genflowly.models.retrieval.StreamChunk
import com.genflowly.providers.RetrievalServerClient
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/**
 * Every generation turn is registered under the caller's customerId while it
 * runs, and leaves the registry only after its persistence, so the account
 * purge can cancel a customer's turns and wait for what they store (3.9).
 */
class GenerationOrchestratorActiveTurnsTest {

    private val cust = "cust-1"
    private val aiConfig = listOf(AIConfig(aiVendor = AIVendor.OPENAI, model = "model-x"))

    private val instructionService = mockk<InstructionService>(relaxed = true)
    private val conversationService = mockk<ConversationService>(relaxed = true)
    private val credentialsService = mockk<CustomerCredentialsService>()
    private val retrievalService = mockk<RetrievalServerClient>()
    private val turns = ActiveTurns()

    private val orchestrator = GenerationOrchestrator(
        credentialsService, instructionService, conversationService, retrievalService,
        mockk(relaxed = true), mockk(relaxed = true), mockk(relaxed = true), mockk(relaxed = true),
        mockk(relaxed = true), AppScope(), mockk(relaxed = true), mockk(relaxed = true), mockk(relaxed = true),
        turns
    )

    init {
        coEvery { instructionService.resolveDefaultInstruction(cust) } returns InstructionResponse(
            id = "i1", version = 1, name = "Coach", instruction = "be kind"
        )
        coEvery { conversationService.resolveWritableConversationId(cust, any(), any(), any()) } returns "conv-1"
        coEvery { credentialsService.getCustomerApiKeyForVendor(any(), cust) } returns "api-key"
    }

    /** Waits, in real time, until [condition] holds: the turns run on other dispatchers. */
    private suspend fun eventually(condition: () -> Boolean) = withContext(Dispatchers.Default) {
        withTimeout(5_000) { while (!condition()) delay(5) }
    }

    /** cancelAndAwait on a real clock (runTest's would let its timeout pass at once). */
    private suspend fun cancelAndAwait(customerId: String): Int = withContext(Dispatchers.Default) {
        turns.cancelAndAwait(customerId, timeoutMs = 5_000)
    }

    private fun persistedAssistantTexts(): List<String> {
        val persisted = mutableListOf<Message>()
        coVerify(atLeast = 0) { conversationService.addMessageInConversation(capture(persisted)) }
        return persisted.filter { it.role == "assistant" }.map { it.text }
    }

    @Test
    fun `a cancelled streamed turn stores its partial text before cancelAndAwait returns`() = runTest {
        val firstToken = CompletableDeferred<Unit>()
        every {
            retrievalService.retrieveAndGenerateStream(
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any()
            )
        } returns flow {
            emit(StreamChunk.Content("The first half"))
            firstToken.complete(Unit)
            CompletableDeferred<Unit>().await() // the vendor goes quiet
        }

        val result = orchestrator.processTextGenerateStreamRequest(
            aiConfig, "", "", "write a long answer", null, null, "REACT_APP", cust
        )
        val relay = launch(Dispatchers.Default) { result.flow.collect {} }
        withContext(Dispatchers.Default) { firstToken.await() }

        assertEquals(1, turns.activeCount(cust))
        assertEquals(1, cancelAndAwait(cust))

        assertEquals(0, turns.activeCount(cust))
        assertEquals(listOf("The first half"), persistedAssistantTexts())
        relay.join() // the relay ends once the turn is done
    }

    @Test
    fun `a streamed turn leaves the registry once it is stored`() = runTest {
        every {
            retrievalService.retrieveAndGenerateStream(
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any()
            )
        } returns flow { emit(StreamChunk.Content("Done.")) }

        val result = orchestrator.processTextGenerateStreamRequest(
            aiConfig, "", "", "hi", null, null, "REACT_APP", cust
        )
        withContext(Dispatchers.Default) { result.flow.collect {} }

        eventually { turns.activeCount(cust) == 0 }
        assertEquals(listOf("Done."), persistedAssistantTexts())
    }

    @Test
    fun `a non-streamed turn is registered while it runs and can be cancelled`() = runTest {
        val reply = CompletableDeferred<RetrievalResult>()
        coEvery {
            retrievalService.retrieveAndGenerate(
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any()
            )
        } coAnswers { reply.await() }

        val turn = async(Dispatchers.Default) {
            orchestrator.processTextGenerateRequest(aiConfig, "", "", "hi", null, null, "REACT_APP", cust)
        }
        eventually { turns.activeCount(cust) == 1 }

        assertEquals(1, cancelAndAwait(cust))
        assertFailsWith<CancellationException> { turn.await() }
        assertEquals(0, turns.activeCount(cust))
        assertEquals(emptyList(), persistedAssistantTexts())
    }

    @Test
    fun `a non-streamed turn leaves the registry once its replies are stored`() = runTest {
        coEvery {
            retrievalService.retrieveAndGenerate(
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any()
            )
        } returns RetrievalResult("ok", 1, 2, 3, null)

        orchestrator.processTextGenerateRequest(aiConfig, "", "", "hi", null, null, "REACT_APP", cust)

        assertEquals(0, turns.activeCount(cust))
        assertEquals(listOf("ok"), persistedAssistantTexts())
    }
}
