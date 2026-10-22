package com.genflowly.service

import com.genflowly.models.Conversation
import com.genflowly.models.Message
import com.genflowly.models.ShareRole
import com.genflowly.repository.ConversationAttributes
import com.genflowly.repository.ConversationRepository
import io.mockk.Runs
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.just
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Forking copies the prefix of the conversation up to (and including) the fork
 * point into a brand-new conversation owned by the caller. Any read access
 * suffices (the fork only duplicates what the caller can already see), but the
 * per-customer attributes — pin state, project grouping — are inherited only
 * on owner forks. Copies get fresh message ids with remapped
 * previousMessageId chains so they can never collide with the source's.
 */
class ConversationForkTest {

    private val conv = "conv-src"
    private val owner = "cust-owner"
    private val other = "cust-other"

    private val conversationService = mockk<ConversationService>()
    private val conversationRepo = mockk<ConversationRepository>(relaxed = true)
    private val indexingService = mockk<ConversationIndexingService>(relaxed = true)
    private val service = ConversationManagementService(
        conversationService, conversationRepo, mockk(relaxed = true),
        mockk(relaxed = true), indexingService,
        mockk(relaxed = true), mockk(relaxed = true), mockk(relaxed = true),
        com.genflowly.di.AppScope()
    )

    private fun msg(
        id: String,
        role: String,
        sequence: Int,
        previousMessageId: String? = null,
        text: String = "text-$id"
    ) = Message(
        messageId = id,
        conversationId = conv,
        text = text,
        client = "REACT_APP",
        role = role,
        customerId = owner,
        sequence = sequence,
        systemPrompt = "",
        aiConfig = emptyList(),
        previousMessageId = previousMessageId,
        createdAt = "2026-01-0${sequence + 1}T00:00:00Z"
    )

    /** user → assistant → user → assistant, chained via previousMessageId. */
    private val messages = listOf(
        msg("u1", "user", 0),
        msg("a1", "assistant", 1, previousMessageId = "u1"),
        msg("u2", "user", 2, previousMessageId = "a1"),
        msg("a2", "assistant", 3, previousMessageId = "u2")
    )

    private fun stub(
        role: ShareRole? = ShareRole.OWNER,
        caller: String = owner,
        attributes: ConversationAttributes? = ConversationAttributes(title = "Trip plan")
    ) {
        coEvery { conversationService.getConversationRole(conv, caller) } returns role
        coEvery { conversationRepo.getConversationById(conv) } returns Conversation(conv, owner, "REACT_APP")
        coEvery { conversationRepo.getConversationAttributes(conv, owner) } returns attributes
        coEvery { conversationRepo.getMessagesForConversation(conv) } returns messages
        coEvery {
            conversationRepo.createForkedConversation(any(), any(), any(), any())
        } returns "2026-10-21T00:00:00Z"
    }

    private suspend fun captureCopies(): MutableList<Message> {
        val copies = mutableListOf<Message>()
        coEvery { conversationRepo.createMessage(capture(copies), any()) } just Runs
        return copies
    }

    @Test
    fun `fork copies everything up to and including the fork point, nothing after`() = runTest {
        stub()
        val copies = captureCopies()

        val response = service.forkConversation(conv, "a1", owner)

        assertEquals(listOf("text-u1", "text-a1"), copies.map { it.text })
        assertTrue(copies.none { it.text == "text-u2" || it.text == "text-a2" })
        assertEquals("Forked Trip plan", response.title)
        assertEquals(conv, response.parentConversationId)
        coVerify(exactly = 1) {
            conversationRepo.createForkedConversation(
                match { it.customerId == owner && it.conversationId == response.conversationId },
                "Forked Trip plan", null, conv
            )
        }
    }

    @Test
    fun `copies get fresh ids in the new conversation with remapped chains`() = runTest {
        stub()
        val copies = captureCopies()

        val response = service.forkConversation(conv, "a2", owner)

        assertEquals(4, copies.size)
        assertTrue(copies.all { it.conversationId == response.conversationId })
        assertTrue(copies.none { it.messageId in messages.map { m -> m.messageId } })
        // Chain remap: each copy's previousMessageId is the NEW id of its predecessor
        assertEquals("", copies[0].previousMessageId)
        assertEquals(copies[0].messageId, copies[1].previousMessageId)
        assertEquals(copies[1].messageId, copies[2].previousMessageId)
        assertEquals(copies[2].messageId, copies[3].previousMessageId)
        // Original sequence and timestamps are preserved on write
        assertEquals(listOf(0, 1, 2, 3), copies.map { it.sequence })
        coVerify(exactly = 4) { conversationRepo.createMessage(any(), preserveCreatedAt = true) }
    }

    @Test
    fun `owner fork inherits pin state and project`() = runTest {
        stub(attributes = ConversationAttributes(title = "Trip plan", pinnedAt = "2026-01-01T00:00:00Z", projectId = "PRJ1"))
        captureCopies()

        val response = service.forkConversation(conv, "a1", owner)

        assertEquals("PRJ1", response.projectId)
        coVerify(exactly = 1) {
            conversationRepo.createForkedConversation(
                match { it.projectId == "PRJ1" }, any(), match { it != null }, conv
            )
        }
    }

    @Test
    fun `shared viewer can fork but inherits neither pin nor project`() = runTest {
        stub(role = ShareRole.VIEW, caller = other,
            attributes = ConversationAttributes(title = "Trip plan", pinnedAt = "2026-01-01T00:00:00Z", projectId = "PRJ1"))
        val copies = captureCopies()

        val response = service.forkConversation(conv, "a1", other)

        assertNull(response.projectId)
        assertNull(response.pinnedAt)
        coVerify(exactly = 1) {
            conversationRepo.createForkedConversation(
                match { it.customerId == other && it.projectId == null }, any(), null, conv
            )
        }
        // Author attribution on copies is preserved, not rewritten to the caller
        assertTrue(copies.all { it.customerId == owner })
    }

    @Test
    fun `no access cannot fork`() = runTest {
        stub(role = null, caller = other)

        assertFailsWith<ConversationAccessDeniedException> { service.forkConversation(conv, "a1", other) }

        coVerify(exactly = 0) { conversationRepo.createForkedConversation(any(), any(), any(), any()) }
        coVerify(exactly = 0) { conversationRepo.createMessage(any(), any()) }
    }

    @Test
    fun `unknown fork point is rejected before anything is created`() = runTest {
        stub()

        assertFailsWith<IllegalArgumentException> { service.forkConversation(conv, "nope", owner) }

        coVerify(exactly = 0) { conversationRepo.createForkedConversation(any(), any(), any(), any()) }
    }

    @Test
    fun `untitled source falls back to Forked conversation`() = runTest {
        stub(attributes = ConversationAttributes(title = "  "))
        captureCopies()

        val response = service.forkConversation(conv, "a1", owner)

        assertEquals("Forked conversation", response.title)
    }

    @Test
    fun `copied exchanges are re-indexed under the fork's ids`() = runTest {
        stub()
        val copies = captureCopies()

        val response = service.forkConversation(conv, "a2", owner, bearerToken = "tok")

        val newAssistantIds = copies.filter { it.role == "assistant" }.map { it.messageId }
        assertEquals(2, newAssistantIds.size)
        newAssistantIds.forEach { newId ->
            verify(exactly = 1) {
                indexingService.indexExchangeAsync(owner, response.conversationId, "REACT_APP", any(), newId, "tok")
            }
        }
    }
}
