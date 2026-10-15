package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.models.AttachmentRef
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.MessageFileRefs
import com.genflowly.repository.MessageKey
import com.genflowly.testsupport.FakeTaggedS3
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import java.time.Duration
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ClaimReconcilerTest {

    private val s3 = FakeTaggedS3()
    private val repo = mockk<ConversationRepository>(relaxed = true)
    private val claims = ObjectClaimService(s3.provider, retryBaseDelayMs = 1)
    private val now = Instant.parse("2026-10-15T12:00:00Z")
    private val reconciler = ClaimReconciler(repo, claims, AppScope()) { now }

    private fun key(id: String) = "customers/c1/attachments/$id"

    private fun pendingRow(id: String, vararg attachmentIds: String) = MessageFileRefs(
        conversationId = "conv-1", messageId = id, customerId = "c1", role = "user",
        attachments = attachmentIds.map { AttachmentRef(it, key(it), "image/png") },
        toolResultsJson = null, fsNamespace = null, runId = null, claimPending = true, createdAt = null
    )

    @Test
    fun `nothing pending is a no-op`() = runTest {
        coEvery { repo.getClaimPendingMessageKeys(any()) } returns emptyList()
        assertEquals(ClaimReconciler.SweepResult(0, 0, 0, overdue = false), reconciler.sweep())
    }

    @Test
    fun `a claim that still fails stays pending and keeps the flag`() = runTest {
        s3.put(key("a"), "retention" to "pending")
        s3.failingKeys += key("a")
        coEvery { repo.getClaimPendingMessageKeys(any()) } returns listOf(MessageKey("conv-1", "m1") to now.toString())
        coEvery { repo.getMessageFileRefs("conv-1", "m1") } returns pendingRow("m1", "a")
        coEvery { repo.updateMessageRetention(any(), any(), any(), any(), any()) } returns true

        val result = reconciler.sweep()

        assertEquals(1, result.stillPending)
        coVerify { repo.updateMessageRetention("conv-1", "m1", null, null, false) }
    }

    @Test
    fun `a copy made by the reconciler is stored on the row as it clears the flag`() = runTest {
        s3.put(key("a"), "retention" to "kept", "conv" to "conv-other")
        coEvery { repo.getClaimPendingMessageKeys(any()) } returns listOf(MessageKey("conv-1", "m1") to now.toString())
        coEvery { repo.getMessageFileRefs("conv-1", "m1") } returns pendingRow("m1", "a")
        coEvery { repo.updateMessageRetention(any(), any(), any(), any(), any()) } returns true

        reconciler.sweep()

        coVerify {
            repo.updateMessageRetention("conv-1", "m1", match { it!!.single().s3Key != key("a") }, null, true)
        }
    }

    @Test
    fun `a row deleted meanwhile gets its new claims released`() = runTest {
        s3.put(key("a"), "retention" to "pending")
        coEvery { repo.getClaimPendingMessageKeys(any()) } returns listOf(MessageKey("conv-1", "m1") to now.toString())
        coEvery { repo.getMessageFileRefs("conv-1", "m1") } returns pendingRow("m1", "a")
        coEvery { repo.updateMessageRetention(any(), any(), any(), any(), any()) } returns false

        reconciler.sweep()

        assertEquals(mapOf("retention" to "pending"), s3.tags(key("a")))
    }

    @Test
    fun `the oldest pending claim past three days is flagged overdue`() = runTest {
        coEvery { repo.getClaimPendingMessageKeys(any()) } returns listOf(
            MessageKey("conv-1", "old") to now.minus(Duration.ofDays(4)).toString(),
            MessageKey("conv-1", "new") to now.minus(Duration.ofHours(1)).toString()
        )
        coEvery { repo.getMessageFileRefs(any(), any()) } returns null

        assertTrue(reconciler.sweep().overdue)

        coEvery { repo.getClaimPendingMessageKeys(any()) } returns listOf(
            MessageKey("conv-1", "recent") to now.minus(Duration.ofDays(2)).toString()
        )
        assertFalse(reconciler.sweep().overdue)
    }
}
