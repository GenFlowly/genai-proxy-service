package com.genflowly.service

import com.genflowly.models.Conversation
import com.genflowly.models.api.Project
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.ProjectRepository
import com.genflowly.repository.ShareRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Creating a conversation inside a project (the generation-request path):
 * projectId only applies to the create branch, must belong to the caller, and
 * a stale/unknown project is dropped with a warning rather than failing the
 * generation — sending a message must never fail over a sidebar grouping.
 */
class ConversationCreateInProjectTest {

    private val cust = "cust-1"
    private val client = "REACT_APP"
    private val proj = "PRJ123"

    private val conversationRepo = mockk<ConversationRepository>(relaxed = true)
    private val shareRepo = mockk<ShareRepository>(relaxed = true)
    private val customerProfileRepo = mockk<CustomerProfileRepository>(relaxed = true)
    private val projectRepo = mockk<ProjectRepository>()
    private val service = ConversationService(conversationRepo, shareRepo, customerProfileRepo, projectRepo)

    private fun project() = Project(
        projectId = proj, name = "Research",
        createdAt = "2026-01-01T00:00:00Z", updatedAt = "2026-01-01T00:00:00Z"
    )

    @Test
    fun `new conversation is created inside an existing project`() = runTest {
        coEvery { projectRepo.getProject(cust, proj) } returns project()
        val created = slot<Conversation>()
        coEvery { conversationRepo.createConversation(capture(created)) } returns Unit

        val id = service.resolveWritableConversationId(cust, client, conversationId = null, projectId = proj)

        assertEquals(id, created.captured.conversationId)
        assertEquals(proj, created.captured.projectId)
    }

    @Test
    fun `unknown project is dropped rather than failing the generation`() = runTest {
        coEvery { projectRepo.getProject(cust, "PRJGONE") } returns null
        val created = slot<Conversation>()
        coEvery { conversationRepo.createConversation(capture(created)) } returns Unit

        service.resolveWritableConversationId(cust, client, conversationId = null, projectId = "PRJGONE")

        assertNull(created.captured.projectId)
    }

    @Test
    fun `projectId is ignored when continuing an existing conversation`() = runTest {
        coEvery { conversationRepo.getConversationById("conv-9") } returns
            Conversation(conversationId = "conv-9", customerId = cust, client = client)

        val id = service.resolveWritableConversationId(cust, client, conversationId = "conv-9", projectId = proj)

        assertEquals("conv-9", id)
        coVerify(exactly = 0) { projectRepo.getProject(any(), any()) }
        coVerify(exactly = 0) { conversationRepo.createConversation(any()) }
    }

    @Test
    fun `no project lookup happens when none was requested`() = runTest {
        val created = slot<Conversation>()
        coEvery { conversationRepo.createConversation(capture(created)) } returns Unit

        service.resolveWritableConversationId(cust, client, conversationId = null, projectId = null)

        assertNull(created.captured.projectId)
        coVerify(exactly = 0) { projectRepo.getProject(any(), any()) }
    }
}
