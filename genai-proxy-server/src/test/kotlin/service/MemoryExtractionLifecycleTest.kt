package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.models.AgentOutputFormat
import com.genflowly.models.Message
import com.genflowly.models.RequestType
import com.genflowly.models.ResolvedAgent
import com.genflowly.models.api.CustomerMemory
import com.genflowly.models.api.MemoryKind
import com.genflowly.models.api.MemorySourceType
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.MemoryRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import java.time.Instant
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * The durable extraction lifecycle, driven through the reconciler entry point
 * (processDuePendingExtractions → runConversationExtraction inline). Pinned:
 *
 *  * success: window claimed → operations applied → facts on the message →
 *    claim finalized → pending row drained
 *  * retryable failure (all providers failed): window ROLLED BACK, pending row
 *    kept for the next sweep, and NO "[]" marker (an in-window retry can still
 *    land real facts) — the fix for the silently-unlearned final exchange
 *  * unresolved action / no keys: terminal — rollback + "[]" + row drained
 *  * a lost claim settles its own message but leaves the row to the owner
 *  * attempts cap: exhausted rows settle "[]" and drain without running
 *  * a stale (crashed) claim is rolled back before the retry runs
 */
class MemoryExtractionLifecycleTest {

    private val resolution = mockk<AgentResolutionService>()
    private val executor = mockk<GenerationAgentExecutor>()
    private val memoryRepo = mockk<MemoryRepository>(relaxed = true)
    private val memoryService = mockk<MemoryService>()
    private val conversationService = mockk<ConversationService>(relaxed = true)
    private val profiles = mockk<CustomerProfileRepository>(relaxed = true)
    private val retrievalClient = mockk<com.genflowly.providers.RetrievalServerClient>(relaxed = true)

    private val service = MemoryExtractionService(
        resolution, executor, memoryRepo, memoryService, conversationService,
        profiles, retrievalClient, AppScope(), logContent = false
    )

    private val agent = ResolvedAgent(
        requestType = RequestType.MEMORY_EXTRACTION, mapKey = "k", graphId = "GRP1",
        outputFormat = AgentOutputFormat.JSON
    )

    private fun message(i: Int) = Message(
        conversationId = "CONV1", text = "msg $i", client = "test",
        role = if (i % 2 == 0) "user" else "assistant", customerId = "CU1",
        systemPrompt = "", aiConfig = emptyList(), previousMessageId = null
    )

    private val pending = MemoryRepository.PendingExtraction(
        customerId = "CU1", conversationId = "CONV1",
        dueAt = Instant.now().toString(), attempts = 0, responseMessageId = "MSG9"
    )

    private fun baseline(threadSize: Int = 6, processed: Int? = 2) {
        coEvery { memoryRepo.duePendingExtractions(any(), any()) } returns listOf(pending)
        coEvery { memoryRepo.startPendingAttempt("CU1", "CONV1", any()) } returns 1
        coEvery { memoryRepo.getExtractionMark("CU1", "CONV1") } returns
            MemoryRepository.ExtractionMark(processed = processed, claimedFrom = null, claimedAt = null)
        coEvery { memoryService.isMemoryEnabled("CU1") } returns true
        coEvery { conversationService.getLatestMessageId("CONV1") } returns "M-last"
        coEvery { conversationService.getMessageThread("CONV1", "M-last") } returns
            (1..threadSize).map { message(it) }
        coEvery { memoryRepo.claimConversationExtraction("CU1", "CONV1", processed, threadSize) } returns true
        coEvery { memoryRepo.getMemories("CU1") } returns emptyList()
        coEvery { resolution.resolve(RequestType.MEMORY_EXTRACTION, "CU1") } returns agent
        coEvery { memoryRepo.createMemory(any(), any(), any(), any(), any(), any()) } returns CustomerMemory(
            memoryId = "MEM#new", text = "Is named Neel.", kind = MemoryKind.EPISODIC,
            sourceType = MemorySourceType.CONVERSATION, createdAt = "t", updatedAt = "t"
        )
    }

    /** Stub the executor to run the REAL parse lambda on [output]. */
    private fun executorReturns(output: String) {
        coEvery {
            executor.executeWithCustomerFailover<List<Any?>>(
                any(), any(), any(), any(), any(), any(), any()
            )
        } answers {
            // arg(6) is the parse lambda (lastArg would be the suspend continuation)
            @Suppress("UNCHECKED_CAST")
            (arg<Any?>(6) as (String) -> List<Any?>).invoke(output)
        }
    }

    @Test
    fun `success - applies operations, writes facts, finalizes, drains the row`() = runTest {
        baseline()
        executorReturns("""{"operations":[{"op":"ADD","text":"Is named Neel.","kind":"EPISODIC","category":"profile"}]}""")

        service.processDuePendingExtractions()

        coVerify { memoryRepo.createMemory("CU1", "Is named Neel.", MemoryKind.EPISODIC, "profile", MemorySourceType.CONVERSATION, "CONV1") }
        coVerify { retrievalClient.encodeMemoryVector("CU1", "MEM#new", "Is named Neel.", any(), any(), any(), any()) }
        coVerify {
            conversationService.setMessageLearnedFacts("CONV1", "MSG9", match { it.contains("Is named Neel.") })
        }
        coVerify { memoryRepo.finalizeConversationExtraction("CU1", "CONV1", 6) }
        coVerify { memoryRepo.deletePendingExtraction("CU1", "CONV1") }
        coVerify(exactly = 0) { memoryRepo.rollbackConversationExtractionMark(any(), any(), any(), any()) }
    }

    @Test
    fun `retryable failure - rolls back, keeps the row, writes no marker`() = runTest {
        baseline()
        coEvery {
            executor.executeWithCustomerFailover<List<Any?>>(any(), any(), any(), any(), any(), any(), any())
        } throws CustomerAIFailoverException("all failed", listOf("OPENAI/gpt-5: cap"))

        service.processDuePendingExtractions()

        coVerify { memoryRepo.rollbackConversationExtractionMark("CU1", "CONV1", 2, 6) }
        coVerify(exactly = 0) { memoryRepo.deletePendingExtraction(any(), any()) }
        coVerify(exactly = 0) { conversationService.setMessageLearnedFacts(any(), any(), any()) }
        coVerify(exactly = 0) { memoryRepo.finalizeConversationExtraction(any(), any(), any()) }
    }

    @Test
    fun `blank output throws through the parse and is retryable`() = runTest {
        baseline()
        executorReturns("")

        service.processDuePendingExtractions()

        coVerify { memoryRepo.rollbackConversationExtractionMark("CU1", "CONV1", 2, 6) }
        coVerify(exactly = 0) { memoryRepo.deletePendingExtraction(any(), any()) }
    }

    @Test
    fun `unresolved action is terminal - rollback, marker, row drained`() = runTest {
        baseline()
        coEvery { resolution.resolve(RequestType.MEMORY_EXTRACTION, "CU1") } throws
            RequestAgentUnresolvedException(RequestType.MEMORY_EXTRACTION)

        service.processDuePendingExtractions()

        coVerify { memoryRepo.rollbackConversationExtractionMark("CU1", "CONV1", 2, 6) }
        coVerify { conversationService.setMessageLearnedFacts("CONV1", "MSG9", "[]") }
        coVerify { memoryRepo.deletePendingExtraction("CU1", "CONV1") }
    }

    @Test
    fun `lost claim settles its own message but leaves the row to the owner`() = runTest {
        baseline()
        coEvery { memoryRepo.claimConversationExtraction("CU1", "CONV1", 2, 6) } returns false

        service.processDuePendingExtractions()

        coVerify { conversationService.setMessageLearnedFacts("CONV1", "MSG9", "[]") }
        coVerify(exactly = 0) { memoryRepo.deletePendingExtraction(any(), any()) }
        coVerify(exactly = 0) { resolution.resolve(any(), any()) }
    }

    @Test
    fun `attempts cap - exhausted rows settle and drain without running`() = runTest {
        baseline()
        coEvery { memoryRepo.startPendingAttempt("CU1", "CONV1", any()) } returns 4

        service.processDuePendingExtractions()

        coVerify { conversationService.setMessageLearnedFacts("CONV1", "MSG9", "[]") }
        coVerify { memoryRepo.deletePendingExtraction("CU1", "CONV1") }
        coVerify(exactly = 0) { memoryRepo.claimConversationExtraction(any(), any(), any(), any()) }
    }

    @Test
    fun `a stale crashed claim is rolled back before the retry runs`() = runTest {
        baseline(processed = 2)
        val stale = MemoryRepository.ExtractionMark(
            processed = 6, claimedFrom = 2, claimedAt = Instant.now().minusSeconds(600)
        )
        val recovered = MemoryRepository.ExtractionMark(processed = 2, claimedFrom = null, claimedAt = null)
        coEvery { memoryRepo.getExtractionMark("CU1", "CONV1") } returnsMany listOf(stale, recovered)
        executorReturns("""{"operations":[]}""")

        service.processDuePendingExtractions()

        // Recovery released the crashed claim's window (6 → 2)…
        coVerify { memoryRepo.rollbackConversationExtractionMark("CU1", "CONV1", 2, 6) }
        // …and the retry then claimed and completed it normally.
        coVerify { memoryRepo.claimConversationExtraction("CU1", "CONV1", 2, 6) }
        coVerify { memoryRepo.finalizeConversationExtraction("CU1", "CONV1", 6) }
    }

    @Test
    fun `operations schema requires the operations array`() {
        val schema = MemoryExtractionService.OPERATIONS_SCHEMA.toString()
        assertTrue(schema.contains("\"operations\""))
        assertTrue(schema.contains("\"required\":[\"operations\"]"))
        assertTrue(schema.contains("\"enum\":[\"ADD\",\"UPDATE\",\"DELETE\"]"))
    }
}
