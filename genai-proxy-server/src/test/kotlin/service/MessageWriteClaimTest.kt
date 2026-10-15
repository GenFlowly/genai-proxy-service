package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.models.AIConfig
import com.genflowly.models.AIVendor
import com.genflowly.models.AttachmentRef
import com.genflowly.models.Message
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.ConversationWriteState
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.MessageFileRefs
import com.genflowly.repository.MessageKey
import com.genflowly.repository.ShareRepository
import com.genflowly.testsupport.FakeTaggedS3
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.coVerifyOrder
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.test.runTest
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * ConversationService.addMessageInConversation, the single message-write
 * choke point: the write guard (3.9), the kept-object claim before the
 * PutItem (1.16), claimPending on a failed claim and its reconciliation, the
 * rollback when the PutItem fails, and the release of a replaced row's keys.
 */
class MessageWriteClaimTest {

    private val conv = "conv-1"
    private val customer = "cust-1"
    private val s3 = FakeTaggedS3()
    private val repo = mockk<ConversationRepository>(relaxed = true)
    private val claims = ObjectClaimService(s3.provider, retryBaseDelayMs = 1)
    private val service = ConversationService(
        repo, mockk<ShareRepository>(relaxed = true), mockk<CustomerProfileRepository>(relaxed = true),
        mockk(relaxed = true), claims
    )
    private val stored = mutableListOf<Message>()
    private val kept = mapOf("retention" to "kept", "conv" to conv)

    private fun key(id: String) = "customers/$customer/attachments/$id"

    private fun message(id: String, vararg attachmentIds: String, role: String = "user") = Message(
        messageId = id, conversationId = conv, text = "hi",
        attachments = attachmentIds.map { AttachmentRef(it, key(it), "image/png") },
        client = "REACT_APP", role = role, customerId = customer, systemPrompt = "",
        aiConfig = listOf(AIConfig(AIVendor.CLAUDE, "m")), previousMessageId = null
    )

    private fun Message.asRefs() = MessageFileRefs(
        conversationId, messageId, customerId, role, attachments, toolResultsJson,
        fsNamespace, runId, claimPending, createdAt
    )

    init {
        coEvery { repo.getConversationWriteState(customer, conv) } returns
            ConversationWriteState(customer, conv, archived = false, purgeStartedAt = null)
        coEvery { repo.getMessageFileRefs(conv, any()) } returns null
        coEvery { repo.createMessage(any()) } answers { stored += firstArg<Message>() }
    }

    @Test
    fun `objects are tagged kept before the message is written`() = runTest {
        s3.put(key("img"), "retention" to "pending")

        service.addMessageInConversation(message("m1", "img"))

        assertEquals(kept, s3.tags(key("img")))
        coVerifyOrder {
            s3.provider.putObjectTagging(key("img"), kept)
            repo.createMessage(any())
        }
        assertFalse(stored.single().claimPending)
    }

    @Test
    fun `a claim that keeps failing stores the message with claimPending, and the reconciler finishes it`() = runTest {
        s3.put(key("img"), "retention" to "pending")
        s3.failingKeys += key("img")

        service.addMessageInConversation(message("m1", "img"))

        val row = stored.single()
        assertTrue(row.claimPending)
        assertEquals(mapOf("retention" to "pending"), s3.tags(key("img")))

        // S3 recovers; the reconciler picks the row up from the claimPending index
        s3.failingKeys.clear()
        coEvery { repo.getClaimPendingMessageKeys(any()) } returns
            listOf(MessageKey(conv, "m1") to Instant.now().toString())
        coEvery { repo.getMessageFileRefs(conv, "m1") } returns row.asRefs()
        coEvery { repo.updateMessageRetention(any(), any(), any(), any(), any()) } returns true

        val result = ClaimReconciler(repo, claims, AppScope()).sweep()

        assertEquals(1, result.claimed)
        assertEquals(kept, s3.tags(key("img")))
        coVerify { repo.updateMessageRetention(conv, "m1", null, null, true) }
    }

    @Test
    fun `a key kept by another conversation is copied and the stored ref points at the copy`() = runTest {
        s3.put(key("img"), "retention" to "kept", "conv" to "conv-other")

        service.addMessageInConversation(message("m1", "img"))

        val ref = stored.single().attachments.single()
        assertTrue(ref.s3Key != key("img") && ref.s3Key.startsWith("customers/$customer/attachments/"))
        assertEquals(kept, s3.tags(ref.s3Key))
        assertEquals(mapOf("retention" to "kept", "conv" to "conv-other"), s3.tags(key("img")))
    }

    @Test
    fun `when the write fails the claimed keys go back to pending`() = runTest {
        s3.put(key("new"), "retention" to "pending")
        s3.put(key("already"), "retention" to "kept", "conv" to conv)
        coEvery { repo.createMessage(any()) } throws RuntimeException("DynamoDB down")

        assertFailsWith<RuntimeException> { service.addMessageInConversation(message("m1", "new", "already")) }

        assertEquals(mapOf("retention" to "pending"), s3.tags(key("new")))
        // Kept before this write (another message links it): untouched
        assertEquals(kept, s3.tags(key("already")))
    }

    @Test
    fun `a replaced row releases the keys only it linked`() = runTest {
        for (id in listOf("a", "b", "c")) s3.put(key(id), "retention" to "kept", "conv" to conv)
        val previous = message("m1", "a", "b", role = "assistant")
        coEvery { repo.getMessageFileRefs(conv, "m1") } returns previous.asRefs()
        // Another message of the conversation still links b
        coEvery { repo.getMessageFileRefs(conv) } returns listOf(message("m0", "b").asRefs(), previous.asRefs())

        service.addMessageInConversation(message("m1", "c", role = "assistant"))

        assertEquals(mapOf("retention" to "pending"), s3.tags(key("a")))
        assertEquals(kept, s3.tags(key("b")))
        assertEquals(kept, s3.tags(key("c")))
    }

    @Test
    fun `a write to a conversation that is gone or being purged is refused before any claim`() = runTest {
        s3.put(key("img"), "retention" to "pending")
        for (state in listOf(
            null,
            ConversationWriteState(customer, conv, archived = false, purgeStartedAt = "2026-10-15T00:00:00Z")
        )) {
            coEvery { repo.getConversationWriteState(customer, conv) } returns state
            assertFailsWith<ConversationAccessDeniedException> {
                service.addMessageInConversation(message("m1", "img"))
            }
        }
        assertTrue(stored.isEmpty())
        assertTrue(s3.calls.isEmpty(), s3.calls.toString())
        assertEquals(mapOf("retention" to "pending"), s3.tags(key("img")))
    }

    @Test
    fun `an archived conversation still takes messages`() = runTest {
        coEvery { repo.getConversationWriteState(customer, conv) } returns
            ConversationWriteState(customer, conv, archived = true, purgeStartedAt = null)
        service.addMessageInConversation(message("m1"))
        assertEquals(1, stored.size)
    }

    @Test
    fun `a message without files makes no S3 call`() = runTest {
        val sent = slot<Message>()
        coEvery { repo.createMessage(capture(sent)) } returns Unit

        service.addMessageInConversation(message("m1"))

        assertTrue(s3.calls.isEmpty())
        assertFalse(sent.captured.claimPending)
    }
}
