package com.genflowly.service

import com.genflowly.models.AIConfig
import com.genflowly.models.AIVendor
import com.genflowly.models.Conversation
import com.genflowly.models.Message
import com.genflowly.models.ShareRole
import com.genflowly.repository.ConversationAttributes
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.ShareRepository
import com.genflowly.repository.TouchResult
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/**
 * Deleting a conversation: only the owner's delete is permanent; anyone it
 * was shared with only leaves it. And a message saved after its conversation
 * was deleted (a reply still generating) is removed again at once, so
 * nothing can bring the conversation back.
 */
class ConversationDeleteTest {

    private val conv = "conv-1"
    private val owner = "cust-owner"
    private val other = "cust-other"

    private val conversationService = mockk<ConversationService>()
    private val conversationRepo = mockk<ConversationRepository>(relaxed = true)
    private val shareRepo = mockk<ShareRepository>(relaxed = true)
    private val contentDeletion = mockk<ContentDeletionService>(relaxed = true)
    private val service = ConversationManagementService(
        conversationService, conversationRepo, shareRepo,
        mockk(relaxed = true), mockk(relaxed = true), mockk(relaxed = true), mockk(relaxed = true),
        mockk(relaxed = true), contentDeletion, com.genflowly.di.AppScope()
    )

    private fun stubRole(customerId: String, role: ShareRole?) {
        coEvery { conversationService.getConversationRole(conv, customerId) } returns role
    }

    @Test
    fun `the owner's delete is permanent and carries the fork parent`() = runTest {
        stubRole(owner, ShareRole.OWNER)
        coEvery { conversationRepo.getConversationAttributes(conv, owner) } returns
            ConversationAttributes(parentConversationId = "conv-0")

        assertEquals(ConversationManagementService.DeleteResult.DELETED, service.deleteConversation(conv, owner))

        coVerify { contentDeletion.requestConversationDeletion(owner, conv, "conv-0") }
        coVerify(exactly = 0) { shareRepo.unshareConversationWithCustomer(any(), any()) }
    }

    @Test
    fun `someone it was shared with only removes their own access`() = runTest {
        for (role in listOf(ShareRole.EDIT, ShareRole.VIEW)) {
            stubRole(other, role)

            assertEquals(ConversationManagementService.DeleteResult.LEFT_SHARE, service.deleteConversation(conv, other))
        }

        coVerify(exactly = 2) { shareRepo.unshareConversationWithCustomer(conv, other) }
        coVerify(exactly = 0) { contentDeletion.requestConversationDeletion(any(), any(), any()) }
    }

    @Test
    fun `no access is refused`() = runTest {
        stubRole(other, null)

        assertFailsWith<SecurityException> { service.deleteConversation(conv, other) }

        coVerify(exactly = 0) { contentDeletion.requestConversationDeletion(any(), any(), any()) }
        coVerify(exactly = 0) { shareRepo.unshareConversationWithCustomer(any(), any()) }
    }
}

class LateMessageTest {

    private val conv = "conv-1"
    private val owner = "cust-owner"
    private val recipient = "cust-recipient"

    private val conversationRepo = mockk<ConversationRepository>(relaxed = true)
    private val conversations = ConversationService(conversationRepo, mockk(relaxed = true), mockk(relaxed = true), mockk(relaxed = true))

    private fun message(author: String) = Message(
        conversationId = conv, text = "reply", client = "test", role = "assistant", customerId = author,
        systemPrompt = "", aiConfig = listOf(AIConfig(AIVendor.CLAUDE, "claude-haiku-4-5")), previousMessageId = null
    )

    private fun touch(customerId: String, result: TouchResult) {
        coEvery { conversationRepo.touchConversation(customerId, conv, any()) } returns result
    }

    @Test
    fun `a message in a live conversation stays`() = runTest {
        touch(owner, TouchResult.TOUCHED)

        val id = conversations.addMessageInConversation(message(owner))

        coVerify { conversationRepo.createMessage(match { it.messageId == id }, any()) }
        coVerify(exactly = 0) { conversationRepo.deleteMessage(any(), any()) }
    }

    @Test
    fun `a message saved after the owner deleted the conversation is removed again`() = runTest {
        touch(owner, TouchResult.NO_ROW)
        coEvery { conversationRepo.getConversationById(conv) } returns null

        val id = conversations.addMessageInConversation(message(owner))

        coVerify { conversationRepo.deleteMessage(conv, id) }
    }

    @Test
    fun `a touch that failed for another reason never removes the message`() = runTest {
        touch(owner, TouchResult.FAILED)

        conversations.addMessageInConversation(message(owner))

        coVerify(exactly = 0) { conversationRepo.deleteMessage(any(), any()) }
    }

    @Test
    fun `a recipient's message touches the owner's row, and is removed only if that row is gone`() = runTest {
        touch(recipient, TouchResult.NO_ROW)
        coEvery { conversationRepo.getConversationById(conv) } returns Conversation(conv, owner, "REACT_APP")
        touch(owner, TouchResult.TOUCHED)

        conversations.addMessageInConversation(message(recipient))
        coVerify(exactly = 0) { conversationRepo.deleteMessage(any(), any()) }

        touch(owner, TouchResult.NO_ROW)
        val id = conversations.addMessageInConversation(message(recipient))
        coVerify { conversationRepo.deleteMessage(conv, id) }
    }
}
