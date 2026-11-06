package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.providers.CustomerDocumentsPurger
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.providers.S3Provider
import com.genflowly.repository.PurgeJob
import com.genflowly.repository.PurgeJobRepository
import com.genflowly.repository.PurgeJobType
import com.genflowly.repository.PurgeRepository
import com.genflowly.service.ContentDeletionService.Companion.FINAL_SWEEP_DELAY
import com.genflowly.service.ContentDeletionService.Companion.STAGE_CONTENT
import com.genflowly.service.ContentDeletionService.Companion.STAGE_HIDDEN
import com.genflowly.service.ContentDeletionService.Companion.STAGE_VECTORS
import io.mockk.MockKMatcherScope
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.coVerifyOrder
import io.mockk.every
import io.mockk.mockk
import java.time.Duration
import java.time.Instant
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/**
 * Deleting one conversation or note. Pinned here: the request makes it
 * unreachable before it returns; files go before the messages that name
 * them, and both before the vectors; a file another fork still uses is kept
 * and checked again by the final sweep; the final sweep repeats every stage.
 */
class ContentDeletionServiceTest {

    private val jobs = mockk<PurgeJobRepository>(relaxed = true)
    private val purge = mockk<PurgeRepository>(relaxed = true)
    private val s3 = mockk<S3Provider>()
    private val documents = mockk<CustomerDocumentsPurger>()
    private val retrieval = mockk<RetrievalServerClient>(relaxed = true)
    private var now: Instant = Instant.parse("2026-11-05T12:00:00Z")
    private val runner = PurgeJobRunner(jobs) { now }
    private val service = ContentDeletionService(jobs, runner, purge, s3, documents, retrieval, AppScope()) { now }

    private val upload = "customers/CU1/attachments/up-1"
    private val generated = "customers/CU1/attachments/pdf-1"
    private val shared = "customers/CU1/attachments/shared-1"
    private val foreign = "customers/CU9/attachments/theirs"

    init {
        every { s3.isConfigured } returns true
        coEvery { s3.deleteObjects(any()) } returns emptyList()
        every { documents.isConfigured } returns true
        coEvery { documents.purgeNote(any(), any()) } returns 1
        coEvery { retrieval.deleteNoteVectors(any(), any()) } returns true
        coEvery { purge.messageFileKeys("C1") } returns setOf(upload, generated, foreign)
        coEvery { purge.conversationParents("CU1") } returns mapOf("C2" to null)
    }

    private fun conversation(stage: Int, requestedAt: Instant = now, attempts: Int = 1, parentId: String? = null) =
        PurgeJob(PurgeJobType.CONVERSATION, "CU1", "C1", requestedAt, stage, attempts, "2026-11-05T11:00:00Z", parentId = parentId)

    private fun note(stage: Int, requestedAt: Instant = now, attempts: Int = 1) =
        PurgeJob(PurgeJobType.NOTE, "CU1", "N1", requestedAt, stage, attempts, "2026-11-05T11:00:00Z")

    private fun MockKMatcherScope.conversationJob(): PurgeJob = match { it.jobKey == "CONVERSATION#CU1#C1" }
    private fun MockKMatcherScope.noteJob(): PurgeJob = match { it.jobKey == "NOTE#CU1#N1" }

    @Test
    fun `a conversation is unreachable before the request returns, and the rest follows`() = runTest {
        coEvery { jobs.createIfAbsent(any(), any()) } returns true
        coEvery { jobs.get(PurgeJobType.CONVERSATION, "CU1", "C1") } returns conversation(stage = 0, parentId = "C0")

        service.requestConversationDeletion("CU1", "C1", parentId = "C0")

        coVerifyOrder {
            jobs.createIfAbsent(match { it.itemId == "C1" && it.parentId == "C0" }, now.plus(PurgeJobRunner.LEASE))
            purge.deleteConversationShares("C1")
            purge.deleteConversationRow("CU1", "C1")
            jobs.recordStage(conversationJob(), STAGE_HIDDEN, any())
        }
        coVerify(timeout = 5_000) { retrieval.deleteConversationVectors("CU1", "C1") }
        coVerify(timeout = 5_000) { jobs.reschedule(conversationJob(), now.plus(FINAL_SWEEP_DELAY)) }
    }

    @Test
    fun `a failure to hide it fails the request and leaves the job due now`() = runTest {
        coEvery { jobs.createIfAbsent(any(), any()) } returns true
        coEvery { jobs.get(PurgeJobType.CONVERSATION, "CU1", "C1") } returns conversation(stage = 0)
        coEvery { purge.deleteConversationRow(any(), any()) } throws IllegalStateException("throttled")

        assertFailsWith<IllegalStateException> { service.requestConversationDeletion("CU1", "C1", null) }

        coVerify { jobs.reschedule(conversationJob(), now) }
        coVerify(exactly = 0) { retrieval.deleteConversationVectors(any(), any()) }
    }

    @Test
    fun `ids that could widen a file prefix are refused`() = runTest {
        assertFailsWith<IllegalArgumentException> { service.requestConversationDeletion("CU/1", "C1", null) }
        assertFailsWith<IllegalArgumentException> { service.requestNoteDeletion("CU1", "") }
        coVerify(exactly = 0) { jobs.createIfAbsent(any(), any()) }
    }

    @Test
    fun `files go before the messages that name them, and both before the vectors`() = runTest {
        val outcome = service.run(conversation(stage = STAGE_HIDDEN))

        assertEquals(PurgeOutcome.WaitUntil(now.plus(FINAL_SWEEP_DELAY)), outcome)
        coVerifyOrder {
            s3.deleteObjects(match { it.toSet() == setOf(upload, generated) })
            purge.deleteMessages("C1")
            purge.deletePendingVectorRows("CU1", "C1")
            purge.deleteMemoryBookkeeping("CU1", "C1")
            purge.deleteInstructionUsageSeen("CU1", "C1")
            jobs.recordStage(conversationJob(), STAGE_CONTENT, any())
            retrieval.deleteConversationVectors("CU1", "C1")
            jobs.recordStage(conversationJob(), STAGE_VECTORS, any())
        }
    }

    @Test
    fun `another owner's files are never deleted`() = runTest {
        service.run(conversation(stage = STAGE_HIDDEN))

        coVerify(exactly = 0) { s3.deleteObjects(match { foreign in it }) }
    }

    @Test
    fun `a file a fork still uses is kept and recorded`() = runTest {
        coEvery { purge.messageFileKeys("C1") } returns setOf(upload, shared)
        coEvery { purge.conversationParents("CU1") } returns mapOf("C2" to "C1", "C3" to null)
        coEvery { purge.messageFileKeys("C2") } returns setOf(shared)

        service.run(conversation(stage = STAGE_HIDDEN))

        coVerify { s3.deleteObjects(listOf(upload)) }
        coVerify { jobs.recordKeptFiles(conversationJob(), setOf(shared)) }
        coVerify(exactly = 0) { purge.messageFileKeys("C3") }
    }

    @Test
    fun `a conversation without files reads no other conversation`() = runTest {
        coEvery { purge.messageFileKeys("C1") } returns emptySet()

        service.run(conversation(stage = STAGE_HIDDEN))

        coVerify(exactly = 0) { purge.conversationParents(any()) }
        coVerify(exactly = 0) { s3.deleteObjects(any()) }
    }

    @Test
    fun `a resumed job skips the stages it finished`() = runTest {
        service.run(conversation(stage = STAGE_CONTENT))

        coVerify(exactly = 0) { purge.deleteMessages(any()) }
        coVerify { retrieval.deleteConversationVectors("CU1", "C1") }
    }

    @Test
    fun `the final sweep repeats every stage, deletes kept files no fork uses any more, then finishes`() = runTest {
        val sweep = conversation(stage = STAGE_VECTORS, requestedAt = now.minus(Duration.ofMinutes(16)), parentId = "C0")
        coEvery { purge.messageFileKeys("C1") } returns emptySet()
        coEvery { jobs.get(PurgeJobType.CONVERSATION, "CU1", "C1") } returns sweep.copy(keptFileKeys = setOf(shared))
        coEvery { purge.conversationParents("CU1") } returns emptyMap()
        coEvery { purge.messageFileKeys("C0") } returns emptySet()

        val outcome = service.run(sweep)

        assertEquals(PurgeOutcome.Done, outcome)
        coVerify { purge.deleteConversationRow("CU1", "C1") }
        coVerify { purge.deleteMessages("C1") }
        coVerify { s3.deleteObjects(listOf(shared)) }
        coVerify { jobs.forgetKeptFiles(conversationJob(), setOf(shared)) }
        coVerify { retrieval.deleteConversationVectors("CU1", "C1") }
    }

    @Test
    fun `files S3 refuses to delete fail the stage, so the messages stay to try again`() = runTest {
        coEvery { s3.deleteObjects(any()) } returns listOf(upload)

        assertFailsWith<IllegalStateException> { service.run(conversation(stage = STAGE_HIDDEN)) }

        coVerify(exactly = 0) { purge.deleteMessages(any()) }
    }

    @Test
    fun `an unreachable vector DB fails the attempt until the last one, then is skipped with a warning`() = runTest {
        coEvery { retrieval.deleteConversationVectors("CU1", "C1") } throws IllegalStateException("500")

        assertFailsWith<IllegalStateException> { service.run(conversation(stage = STAGE_CONTENT, attempts = 1)) }

        service.run(conversation(stage = STAGE_CONTENT, attempts = AccountDeletionService.VECTOR_ATTEMPTS))
        coVerify { jobs.addWarning(conversationJob(), match { it.startsWith("vectors_not_deleted") }) }
        coVerify { jobs.recordStage(conversationJob(), STAGE_VECTORS, any()) }
    }

    @Test
    fun `a note's row goes before the request returns, then its document and vectors`() = runTest {
        coEvery { jobs.createIfAbsent(any(), any()) } returns true
        coEvery { jobs.get(PurgeJobType.NOTE, "CU1", "N1") } returns note(stage = 0)

        service.requestNoteDeletion("CU1", "N1")

        coVerifyOrder {
            purge.deleteNoteRow("CU1", "N1")
            purge.deletePendingVectorRow("CU1", "N1")
            jobs.recordStage(noteJob(), STAGE_HIDDEN, any())
        }
        coVerify(timeout = 5_000) { documents.purgeNote("CU1", "N1") }
        coVerify(timeout = 5_000) { retrieval.deleteNoteVectors("CU1", "N1") }
    }

    @Test
    fun `a failed note vector delete fails the attempt`() = runTest {
        coEvery { retrieval.deleteNoteVectors("CU1", "N1") } returns false

        assertFailsWith<IllegalStateException> { service.run(note(stage = STAGE_CONTENT)) }
    }

    @Test
    fun `the fork tree follows parents and children, and the deleted conversation's own parent`() {
        val parents = mapOf("C2" to "C1", "C3" to "C2", "C4" to null, "C0" to "CA", "CA" to null, "X" to "Y")

        assertEquals(setOf("C1", "C2", "C3", "C0", "CA"), ContentDeletionService.forkTree("C1", "C0", parents))
        assertEquals(setOf("C1", "C2", "C3"), ContentDeletionService.forkTree("C1", null, parents))
        assertEquals(setOf("C4"), ContentDeletionService.forkTree("C4", null, parents))
    }
}
