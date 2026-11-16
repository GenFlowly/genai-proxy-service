package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.models.AgentOutputFormat
import com.genflowly.models.Message
import com.genflowly.models.RequestType
import com.genflowly.models.ResolvedAgent
import com.genflowly.models.api.CustomerMemory
import com.genflowly.models.api.MemoryChangeType
import com.genflowly.models.api.MemoryKind
import com.genflowly.models.api.MemoryPlacement
import com.genflowly.models.api.MemorySourceType
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.MemoryChangeCause
import com.genflowly.repository.MemoryRepository
import com.genflowly.repository.PendingVectorType
import com.genflowly.repository.VectorSyncPendingRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import io.mockk.slot
import java.time.Instant
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
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
    private val vectorPending = mockk<VectorSyncPendingRepository>(relaxed = true)

    private val service = MemoryExtractionService(
        resolution, executor, memoryRepo, memoryService, conversationService,
        MemoryVectorService(memoryRepo, profiles, retrievalClient, vectorPending, entitlementServiceWith()), AppScope(), logContent = false
    )

    private val agent = ResolvedAgent(
        requestType = RequestType.MEMORY_EXTRACTION, mapKey = "k", graphId = "GRP1",
        outputFormat = AgentOutputFormat.JSON
    )

    private fun message(i: Int) = Message(
        messageId = "M$i", conversationId = "CONV1", text = "msg $i", client = "test",
        role = if (i % 2 == 0) "user" else "assistant", customerId = "CU1",
        systemPrompt = "", aiConfig = emptyList(), previousMessageId = null
    )

    private val pending = MemoryRepository.PendingExtraction(
        customerId = "CU1", conversationId = "CONV1",
        dueAt = Instant.now().toString(), attempts = 0, responseMessageId = "MSG9"
    )

    private fun baseline(threadSize: Int = 6, processed: Int? = 2, projectId: String? = null) {
        coEvery { conversationService.getOwnedConversationProjectId("CONV1", "CU1") } returns projectId
        coEvery { memoryRepo.duePendingExtractions(any(), any()) } returns listOf(pending)
        coEvery { memoryRepo.startPendingAttempt("CU1", "CONV1", any()) } returns 1
        coEvery { memoryRepo.getExtractionMark("CU1", "CONV1") } returns
            MemoryRepository.ExtractionMark(processed = processed, claimedFrom = null, claimedAt = null)
        coEvery { memoryService.getMemorySettings("CU1") } returns
            MemorySettings(learnFromChats = true, learnFromNotes = true, useInReplies = true)
        coEvery { conversationService.getLatestMessageId("CONV1") } returns "M-last"
        coEvery { conversationService.getMessageThread("CONV1", "M-last") } returns
            (1..threadSize).map { message(it) }
        coEvery { memoryRepo.claimConversationExtraction("CU1", "CONV1", processed, threadSize) } returns true
        coEvery { memoryRepo.getMemories("CU1") } returns emptyList()
        coEvery { resolution.resolve(RequestType.MEMORY_EXTRACTION, "CU1") } returns agent
        coEvery { memoryRepo.createMemory(any(), any(), any(), any(), any(), any(), any()) } returns CustomerMemory(
            memoryId = "MEM#new", text = "Is named Alex.", kind = MemoryKind.EPISODIC,
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
        executorReturns("""{"operations":[{"op":"ADD","text":"Is named Alex.","kind":"EPISODIC","category":"profile"}]}""")

        service.processDuePendingExtractions()

        coVerify {
            memoryRepo.createMemory(
                "CU1", "Is named Alex.", listOf(MemoryPlacement(null, MemoryKind.EPISODIC)), "profile",
                MemorySourceType.CONVERSATION, "CONV1", match { it.type == MemoryChangeType.LEARNED }
            )
        }
        coVerify { retrievalClient.encodeMemoryVector("CU1", "MEM#new", "Is named Alex.", any(), any(), any(), any()) }
        coVerify {
            conversationService.setMessageLearnedFacts("CONV1", "MSG9", match { it.contains("Is named Alex.") })
        }
        coVerify { memoryRepo.finalizeConversationExtraction("CU1", "CONV1", 6) }
        coVerify { memoryRepo.deletePendingExtraction("CU1", "CONV1") }
        coVerify(exactly = 0) { memoryRepo.rollbackConversationExtractionMark(any(), any(), any(), any()) }
    }

    @Test
    fun `a failed memory embed is recorded for a retry`() = runTest {
        baseline()
        executorReturns("""{"operations":[{"op":"ADD","text":"Is named Alex.","kind":"EPISODIC","category":"profile"}]}""")
        coEvery { retrievalClient.encodeMemoryVector(any(), any(), any(), any(), any(), any(), any()) } throws
            com.genflowly.providers.VectorEncodeException(500, "zilliz down")

        service.processDuePendingExtractions()

        coVerify { vectorPending.markPending("CU1", PendingVectorType.MEMORY, "MEM#new", null, match { it.isAfter(Instant.now()) }) }
        coVerify { memoryRepo.finalizeConversationExtraction("CU1", "CONV1", 6) }
    }

    @Test
    fun `a memory that can never be embedded is not retried`() = runTest {
        baseline()
        executorReturns("""{"operations":[{"op":"ADD","text":"Is named Alex.","kind":"EPISODIC","category":"profile"}]}""")
        coEvery { retrievalClient.encodeMemoryVector(any(), any(), any(), any(), any(), any(), any()) } throws
            com.genflowly.providers.VectorEncodeException(409, "No vector DB configured")

        service.processDuePendingExtractions()

        coVerify(exactly = 0) { vectorPending.markPending(any(), any(), any(), any(), any()) }
    }

    @Test
    fun `retrying a memory re-embeds its current text, and a forgotten one is gone`() = runTest {
        coEvery { memoryRepo.getMemory("CU1", "MEM#a") } returns CustomerMemory(
            memoryId = "MEM#a", text = "Lives in Seattle.", kind = MemoryKind.CORE,
            sourceType = MemorySourceType.CONVERSATION, createdAt = "t", updatedAt = "t"
        )
        coEvery { memoryRepo.getMemory("CU1", "MEM#gone") } returns null

        assertTrue(service.retryMemoryVector("CU1", "MEM#a"))
        coVerify { retrievalClient.encodeMemoryVector("CU1", "MEM#a", "Lives in Seattle.", any(), any(), any(), any()) }
        assertFalse(service.retryMemoryVector("CU1", "MEM#gone"))
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

    private fun memory(id: String, text: String, vararg placements: MemoryPlacement) = CustomerMemory(
        memoryId = id, text = text, kind = placements.first().kind, sourceType = MemorySourceType.CONVERSATION,
        createdAt = "t", updatedAt = "t", placements = placements.toList(), version = 2, tracked = true, rev = 3
    )

    /** Like [executorReturns], also capturing the template variables the agent saw. */
    private fun executorCapturing(output: String): io.mockk.CapturingSlot<Map<String, String>> {
        val variables = slot<Map<String, String>>()
        coEvery {
            executor.executeWithCustomerFailover<List<Any?>>(
                any(), capture(variables), any(), any(), any(), any(), any()
            )
        } answers {
            @Suppress("UNCHECKED_CAST")
            (arg<Any?>(6) as (String) -> List<Any?>).invoke(output)
        }
        return variables
    }

    @Test
    fun `the transcript is numbered so each change can name its message`() = runTest {
        baseline()
        val variables = executorCapturing(
            """{"operations":[{"op":"ADD","text":"Is named Alex.","kind":"CORE","reason":"States their name","messageIndex":2}]}"""
        )

        service.processDuePendingExtractions()

        val content = variables.captured.getValue("content")
        assertTrue(content.contains("[1] Assistant: msg 1"), content)
        assertTrue(content.contains("[2] User: msg 2"), content)
        coVerify {
            memoryRepo.createMemory(
                "CU1", "Is named Alex.", listOf(MemoryPlacement(null, MemoryKind.CORE)), any(),
                MemorySourceType.CONVERSATION, "CONV1",
                MemoryChangeCause(
                    type = MemoryChangeType.LEARNED, sourceType = MemorySourceType.CONVERSATION,
                    conversationId = "CONV1", messageId = "M2", reason = "States their name"
                )
            )
        }
    }

    @Test
    fun `a conversation in a project learns into that project and never sees other projects`() = runTest {
        baseline(projectId = "PRJa")
        coEvery { memoryRepo.getMemories("CU1") } returns listOf(
            memory("MEM#profile", "Lives in Lisbon.", MemoryPlacement(null, MemoryKind.CORE)),
            memory("MEM#here", "Report due Dec 12.", MemoryPlacement("PRJa", MemoryKind.EPISODIC)),
            memory("MEM#other", "Secret launch plan.", MemoryPlacement("PRJb", MemoryKind.CORE)),
        )
        val variables = executorCapturing(
            """{"operations":[{"op":"ADD","text":"Survey has 420 responses.","kind":"EPISODIC"}]}"""
        )

        service.processDuePendingExtractions()

        val existing = variables.captured.getValue("existingMemories")
        assertTrue(existing.contains("MEM#profile") && existing.contains("\"appliesIn\":\"profile\""), existing)
        assertTrue(existing.contains("MEM#here") && existing.contains("\"appliesIn\":\"this project\""), existing)
        assertFalse(existing.contains("MEM#other"), existing)
        coVerify {
            memoryRepo.createMemory(
                "CU1", "Survey has 420 responses.", listOf(MemoryPlacement("PRJa", MemoryKind.EPISODIC)),
                any(), any(), any(), any()
            )
        }
    }

    @Test
    fun `an update saves a new version of the memory as read, with its cause`() = runTest {
        baseline()
        val stored = memory("MEM#a", "Prefers concise answers.", MemoryPlacement(null, MemoryKind.CORE))
        coEvery { memoryRepo.getMemories("CU1") } returns listOf(stored)
        coEvery { memoryRepo.updateMemoryText(any(), any(), any(), any()) } returns true
        executorReturns(
            """{"operations":[{"op":"UPDATE","memoryId":"MEM#a","text":"Prefers concise answers, conclusion first.","reason":"Adds an ordering preference","messageIndex":4}]}"""
        )

        service.processDuePendingExtractions()

        coVerify {
            memoryRepo.updateMemoryText(
                "CU1", stored, "Prefers concise answers, conclusion first.",
                match { it.type == MemoryChangeType.UPDATED && it.messageId == "M4" && it.reason == "Adds an ordering preference" }
            )
        }
        coVerify { retrievalClient.encodeMemoryVector("CU1", "MEM#a", "Prefers concise answers, conclusion first.", any(), any(), any(), any()) }
    }

    @Test
    fun `an update to a memory the agent can't see is ignored`() = runTest {
        baseline(projectId = "PRJa")
        coEvery { memoryRepo.getMemories("CU1") } returns listOf(
            memory("MEM#other", "Secret launch plan.", MemoryPlacement("PRJb", MemoryKind.CORE)),
        )
        executorReturns("""{"operations":[{"op":"UPDATE","memoryId":"MEM#other","text":"Changed."},{"op":"DELETE","memoryId":"MEM#other"}]}""")

        service.processDuePendingExtractions()

        coVerify(exactly = 0) { memoryRepo.updateMemoryText(any(), any(), any(), any()) }
        coVerify(exactly = 0) { memoryService.deleteMemory(any(), any(), any(), any()) }
    }

    @Test
    fun `forgetting a shared project memory only removes it from this project`() = runTest {
        baseline(projectId = "PRJa")
        coEvery { memoryRepo.getMemories("CU1") } returns listOf(
            memory(
                "MEM#shared", "Client renews in March.",
                MemoryPlacement("PRJa", MemoryKind.CORE), MemoryPlacement("PRJb", MemoryKind.CORE)
            ),
            memory("MEM#profile", "Lives in Lisbon.", MemoryPlacement(null, MemoryKind.CORE)),
        )
        coEvery { memoryService.deleteMemory(any(), any(), any(), any()) } returns false
        executorReturns(
            """{"operations":[{"op":"DELETE","memoryId":"MEM#shared","reason":"No longer a client"},{"op":"DELETE","memoryId":"MEM#profile"}]}"""
        )

        service.processDuePendingExtractions()

        coVerify {
            memoryService.deleteMemory(
                "CU1", "MEM#shared", "PRJa",
                match { it.type == MemoryChangeType.REMOVED_FROM_PROJECT && it.reason == "No longer a client" }
            )
        }
        coVerify { memoryService.deleteMemory("CU1", "MEM#profile", null, any()) }
    }

    @Test
    fun `operations schema explains reason and messageIndex`() {
        val schema = MemoryExtractionService.OPERATIONS_SCHEMA.toString()
        assertTrue(schema.contains("\"reason\""))
        assertTrue(schema.contains("\"messageIndex\":{\"type\":\"integer\""))
    }
}
