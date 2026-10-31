package com.genflowly.service

import com.genflowly.models.ShareRole
import com.genflowly.models.api.ConversationSummary
import com.genflowly.models.api.GetPinnedConversationsResponse
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.ShareRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/**
 * Pin/unpin are owner-only: unlike archive/rename (edit-or-owner, persisted
 * against the owner's row), pin state is per-customer, so shared editors and
 * viewers must be rejected before any write happens.
 */
class ConversationPinTest {

    private val conv = "conv-1"
    private val owner = "cust-owner"
    private val other = "cust-other"

    private val conversationService = mockk<ConversationService>()
    private val conversationRepo = mockk<ConversationRepository>(relaxed = true)
    private val shareRepo = mockk<ShareRepository>(relaxed = true)
    private val service = ConversationManagementService(
        conversationService, conversationRepo, shareRepo,
        mockk(relaxed = true), mockk(relaxed = true), mockk(relaxed = true), mockk(relaxed = true),
        mockk(relaxed = true),
        com.genflowly.di.AppScope()
    )

    private fun stubRole(customerId: String, role: ShareRole?) {
        coEvery { conversationService.getConversationRole(conv, customerId) } returns role
    }

    @Test
    fun `owner can pin`() = runTest {
        stubRole(owner, ShareRole.OWNER)

        service.pinConversation(conv, owner)

        coVerify(exactly = 1) { conversationRepo.pinConversation(conv, owner) }
    }

    @Test
    fun `owner can unpin`() = runTest {
        stubRole(owner, ShareRole.OWNER)

        service.unpinConversation(conv, owner)

        coVerify(exactly = 1) { conversationRepo.unpinConversation(conv, owner) }
    }

    @Test
    fun `shared editor cannot pin`() = runTest {
        stubRole(other, ShareRole.EDIT)

        assertFailsWith<SecurityException> { service.pinConversation(conv, other) }

        coVerify(exactly = 0) { conversationRepo.pinConversation(any(), any()) }
    }

    @Test
    fun `shared viewer cannot pin`() = runTest {
        stubRole(other, ShareRole.VIEW)

        assertFailsWith<SecurityException> { service.pinConversation(conv, other) }

        coVerify(exactly = 0) { conversationRepo.pinConversation(any(), any()) }
    }

    @Test
    fun `unknown conversation cannot be pinned`() = runTest {
        stubRole(other, null)

        assertFailsWith<SecurityException> { service.pinConversation(conv, other) }

        coVerify(exactly = 0) { conversationRepo.pinConversation(any(), any()) }
    }

    @Test
    fun `shared editor cannot unpin`() = runTest {
        stubRole(other, ShareRole.EDIT)

        assertFailsWith<SecurityException> { service.unpinConversation(conv, other) }

        coVerify(exactly = 0) { conversationRepo.unpinConversation(any(), any()) }
    }

    @Test
    fun `getPinnedConversations delegates to repository`() = runTest {
        val pinned = listOf(
            ConversationSummary(
                conversationId = conv, title = "t", createdAt = null,
                updatedAt = null, pinnedAt = "2026-08-30T00:00:00Z"
            )
        )
        coEvery { conversationRepo.getPinnedConversationsByCustomer(owner, any(), any()) } returns
            GetPinnedConversationsResponse(conversations = pinned)

        assertEquals(pinned, service.getPinnedConversations(owner).conversations)
    }
}
