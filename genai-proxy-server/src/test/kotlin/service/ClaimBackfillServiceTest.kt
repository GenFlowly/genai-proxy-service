package com.genflowly.service

import com.genflowly.models.AttachmentRef
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.MessageFileRefs
import com.genflowly.repository.RetentionPage
import com.genflowly.testsupport.FakeTaggedS3
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The one-time backfill claims every linked object of every message row,
 * page by page, resumably and idempotently.
 */
class ClaimBackfillServiceTest {

    private val s3 = FakeTaggedS3()
    private val repo = mockk<ConversationRepository>(relaxed = true)
    private val pauses = mutableListOf<Long>()
    private val service = ClaimBackfillService(
        repo, ObjectClaimService(s3.provider, retryBaseDelayMs = 1), maxMessagesPerSecond = 10
    ) { pauses += it }

    private fun key(id: String, customer: String = "c1") = "customers/$customer/attachments/$id"

    private fun row(conv: String, id: String, vararg attachmentIds: String, toolJson: String? = null, pending: Boolean = false) =
        MessageFileRefs(
            conversationId = conv, messageId = id, customerId = "c1", role = "assistant",
            attachments = attachmentIds.map { AttachmentRef(it, key(it), "application/pdf", sourceKey = key(it) + ".source.md") },
            toolResultsJson = toolJson, fsNamespace = null, runId = null, claimPending = pending, createdAt = null
        )

    @Test
    fun `every page's keys are claimed, and the run resumes from the returned token`() = runTest {
        s3.put(key("p1"), "retention" to "pending")
        s3.put(key("p1") + ".source.md", "retention" to "pending")
        s3.put(key("shot"))
        s3.put(key("p2"), "retention" to "pending")
        s3.put(key("p2") + ".source.md", "retention" to "pending")
        coEvery { repo.scanMessageFileRefs(null, 2) } returns RetentionPage(
            listOf(
                row("conv-1", "m1", "p1"),
                row("conv-1", "m2", toolJson = """[{"tool_call_id":"t","content":"","images":[{"s3_key":"${key("shot")}"}]}]""")
            ),
            nextPageToken = "tok-1"
        )
        coEvery { repo.scanMessageFileRefs("tok-1", 2) } returns RetentionPage(
            listOf(row("conv-2", "m3", "p2"), row("conv-2", "m4")),
            nextPageToken = null
        )

        val first = service.runPage(null, 2)
        assertEquals("tok-1", first.nextPageToken)
        assertEquals(2, first.claimedMessages)
        val second = service.runPage(first.nextPageToken, 2)
        assertNull(second.nextPageToken)
        assertTrue(second.done)
        assertEquals(1, second.messagesWithFiles)

        assertEquals(mapOf("retention" to "kept", "conv" to "conv-1"), s3.tags(key("p1")))
        assertEquals(mapOf("retention" to "kept", "conv" to "conv-1"), s3.tags(key("p1") + ".source.md"))
        assertEquals(mapOf("retention" to "kept", "conv" to "conv-1"), s3.tags(key("shot")))
        assertEquals(mapOf("retention" to "kept", "conv" to "conv-2"), s3.tags(key("p2")))
        // Rate limited: a pause after each message with files (claims here take ~0 ms)
        assertEquals(3, pauses.size)
    }

    @Test
    fun `running a page again changes nothing`() = runTest {
        s3.put(key("p1"), "retention" to "kept", "conv" to "conv-1")
        s3.put(key("p1") + ".source.md", "retention" to "kept", "conv" to "conv-1")
        coEvery { repo.scanMessageFileRefs(any(), any()) } returns RetentionPage(listOf(row("conv-1", "m1", "p1")), null)

        service.runPage(null, 10)

        assertTrue(s3.calls.none { it.startsWith("putTagging") || it.startsWith("copy") }, s3.calls.toString())
        coVerify(exactly = 0) { repo.updateMessageRetention(any(), any(), any(), any(), any()) }
    }

    @Test
    fun `a key two conversations link is copied for the second, which gets the new ref`() = runTest {
        s3.put(key("p1"), "retention" to "pending")
        s3.put(key("p1") + ".source.md", "retention" to "pending")
        coEvery { repo.scanMessageFileRefs(any(), any()) } returns RetentionPage(
            listOf(row("conv-1", "m1", "p1"), row("conv-2", "m2", "p1")), null
        )
        coEvery { repo.updateMessageRetention(any(), any(), any(), any(), any()) } returns true

        val result = service.runPage(null, 10)

        assertEquals(2, result.copiedObjects) // the PDF and its source
        assertEquals("conv-1", s3.tags(key("p1"))!!["conv"])
        coVerify {
            repo.updateMessageRetention("conv-2", "m2", match { it!!.single().s3Key != key("p1") }, null, null)
        }
    }

    @Test
    fun `a failed claim marks the row claimPending, and a later success clears it`() = runTest {
        s3.put(key("p1"), "retention" to "pending")
        s3.failingKeys += key("p1")
        coEvery { repo.scanMessageFileRefs(any(), any()) } returns RetentionPage(listOf(row("conv-1", "m1", "p1")), null)
        coEvery { repo.updateMessageRetention(any(), any(), any(), any(), any()) } returns true

        assertEquals(1, service.runPage(null, 10).pendingMessages)
        coVerify { repo.updateMessageRetention("conv-1", "m1", null, null, true) }

        s3.failingKeys.clear()
        coEvery { repo.scanMessageFileRefs(any(), any()) } returns
            RetentionPage(listOf(row("conv-1", "m1", "p1", pending = true)), null)
        assertEquals(1, service.runPage(null, 10).claimedMessages)
        coVerify { repo.updateMessageRetention("conv-1", "m1", null, null, false) }
    }

    @Test
    fun `a page size outside 1-1000 is clamped`() = runTest {
        coEvery { repo.scanMessageFileRefs(any(), any()) } returns RetentionPage(emptyList(), null)
        service.runPage(null, 50_000)
        service.runPage(null, 0)
        coVerify { repo.scanMessageFileRefs(null, 1000) }
        coVerify { repo.scanMessageFileRefs(null, 1) }
    }
}
