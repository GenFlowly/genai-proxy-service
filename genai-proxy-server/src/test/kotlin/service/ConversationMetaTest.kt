package com.genflowly.service

import com.genflowly.models.Conversation
import com.genflowly.models.ShareRole
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
 * The title-only meta lookup backs unauthenticated link-preview rendering,
 * so its gating must match getConversationHistory exactly: anonymous
 * callers (customerId "PUBLIC") may only see titles of conversations that
 * carry a PUBLIC share row — everything else is access-denied, never a
 * leaked title.
 */
class ConversationMetaTest {

    private val conv = "conv-1"
    private val owner = "cust-owner"

    private val conversationRepo = mockk<ConversationRepository>(relaxed = true)
    private val shareRepo = mockk<ShareRepository>(relaxed = true)
    private val service = ConversationService(
        conversationRepo, shareRepo, mockk(relaxed = true), mockk(relaxed = true)
    )

    private fun stubConversation(exists: Boolean = true) {
        coEvery { conversationRepo.getConversationById(conv) } returns
            if (exists) Conversation(conversationId = conv, customerId = owner, client = "web") else null
    }

    @Test
    fun `anonymous caller gets title of publicly shared conversation`() = runTest {
        stubConversation()
        coEvery { shareRepo.getConversationShare(conv, "PUBLIC") } returns ShareRole.VIEW
        coEvery { conversationRepo.getConversationTitle(conv, owner) } returns "Trip planning"

        assertEquals("Trip planning", service.getConversationTitle(conv, "PUBLIC"))

        // Title must be read from the owner's row, not the caller's.
        coVerify(exactly = 1) { conversationRepo.getConversationTitle(conv, owner) }
    }

    @Test
    fun `anonymous caller is denied on private conversation`() = runTest {
        stubConversation()
        coEvery { shareRepo.getConversationShare(conv, "PUBLIC") } returns null

        assertFailsWith<ConversationAccessDeniedException> {
            service.getConversationTitle(conv, "PUBLIC")
        }

        coVerify(exactly = 0) { conversationRepo.getConversationTitle(any(), any()) }
    }

    @Test
    fun `owner gets title without any share rows`() = runTest {
        stubConversation()
        coEvery { shareRepo.getConversationShare(any(), any()) } returns null
        coEvery { conversationRepo.getConversationTitle(conv, owner) } returns "Trip planning"

        assertEquals("Trip planning", service.getConversationTitle(conv, owner))
    }

    @Test
    fun `unknown conversation is denied`() = runTest {
        stubConversation(exists = false)

        assertFailsWith<ConversationAccessDeniedException> {
            service.getConversationTitle(conv, "PUBLIC")
        }
    }

    @Test
    fun `publicly shared conversation with no title yet returns null`() = runTest {
        stubConversation()
        coEvery { shareRepo.getConversationShare(conv, "PUBLIC") } returns ShareRole.VIEW
        coEvery { conversationRepo.getConversationTitle(conv, owner) } returns null

        assertEquals(null, service.getConversationTitle(conv, "PUBLIC"))
    }
}
