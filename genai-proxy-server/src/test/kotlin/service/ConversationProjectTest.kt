package com.genflowly.service

import com.genflowly.models.ShareRole
import com.genflowly.models.api.ConversationSummary
import com.genflowly.models.api.GetCustomerConversationsResponse
import com.genflowly.models.api.Project
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.ProjectRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

/**
 * Project assignment is owner-only like pinning (written to the caller's own
 * row, surfaced in the caller's own sidebar) and must target a project that
 * exists under the caller's partition. List reads resolve projectName at read
 * time — never denormalized — so renames show up immediately and a dangling
 * projectId degrades to projectName = null.
 */
class ConversationProjectTest {

    private val conv = "conv-1"
    private val owner = "cust-owner"
    private val other = "cust-other"
    private val proj = "PRJ123"

    private val conversationService = mockk<ConversationService>()
    private val conversationRepo = mockk<ConversationRepository>(relaxed = true)
    private val projectRepo = mockk<ProjectRepository>()
    private val service = ConversationManagementService(
        conversationService, conversationRepo, mockk(relaxed = true), projectRepo,
        mockk(relaxed = true), mockk(relaxed = true), mockk(relaxed = true),
        com.genflowly.di.AppScope()
    )

    private fun stubRole(customerId: String, role: ShareRole?) {
        coEvery { conversationService.getConversationRole(conv, customerId) } returns role
    }

    private fun project(id: String = proj, name: String = "Research") = Project(
        projectId = id, name = name, createdAt = "2026-01-01T00:00:00Z", updatedAt = "2026-01-01T00:00:00Z"
    )

    private fun summary(id: String, projectId: String? = null) = ConversationSummary(
        conversationId = id, title = "t-$id", createdAt = null, updatedAt = null, projectId = projectId
    )

    // ─── Assign / unassign ─────────────────────────────────────────────────────

    @Test
    fun `owner can assign a conversation to an existing project`() = runTest {
        stubRole(owner, ShareRole.OWNER)
        coEvery { projectRepo.getProject(owner, proj) } returns project()

        service.assignConversationToProject(conv, owner, proj)

        coVerify(exactly = 1) { conversationRepo.setConversationProject(conv, owner, proj) }
    }

    @Test
    fun `assigning again overwrites the previous assignment - move between projects`() = runTest {
        stubRole(owner, ShareRole.OWNER)
        coEvery { projectRepo.getProject(owner, proj) } returns project()
        coEvery { projectRepo.getProject(owner, "PRJ456") } returns project(id = "PRJ456", name = "Other")

        service.assignConversationToProject(conv, owner, proj)
        service.assignConversationToProject(conv, owner, "PRJ456")

        coVerify(exactly = 1) { conversationRepo.setConversationProject(conv, owner, proj) }
        coVerify(exactly = 1) { conversationRepo.setConversationProject(conv, owner, "PRJ456") }
    }

    @Test
    fun `assign to a missing project is not found and writes nothing`() = runTest {
        stubRole(owner, ShareRole.OWNER)
        coEvery { projectRepo.getProject(owner, proj) } returns null

        assertFailsWith<ProjectNotFoundException> {
            service.assignConversationToProject(conv, owner, proj)
        }

        coVerify(exactly = 0) { conversationRepo.setConversationProject(any(), any(), any()) }
    }

    @Test
    fun `shared editor cannot assign`() = runTest {
        stubRole(other, ShareRole.EDIT)

        assertFailsWith<SecurityException> { service.assignConversationToProject(conv, other, proj) }

        coVerify(exactly = 0) { projectRepo.getProject(any(), any()) }
        coVerify(exactly = 0) { conversationRepo.setConversationProject(any(), any(), any()) }
    }

    @Test
    fun `shared viewer cannot assign`() = runTest {
        stubRole(other, ShareRole.VIEW)

        assertFailsWith<SecurityException> { service.assignConversationToProject(conv, other, proj) }

        coVerify(exactly = 0) { conversationRepo.setConversationProject(any(), any(), any()) }
    }

    @Test
    fun `unknown conversation cannot be assigned`() = runTest {
        stubRole(other, null)

        assertFailsWith<SecurityException> { service.assignConversationToProject(conv, other, proj) }

        coVerify(exactly = 0) { conversationRepo.setConversationProject(any(), any(), any()) }
    }

    @Test
    fun `owner can unassign`() = runTest {
        stubRole(owner, ShareRole.OWNER)

        service.unassignConversationFromProject(conv, owner)

        coVerify(exactly = 1) { conversationRepo.removeConversationProject(conv, owner) }
    }

    @Test
    fun `shared editor cannot unassign`() = runTest {
        stubRole(other, ShareRole.EDIT)

        assertFailsWith<SecurityException> { service.unassignConversationFromProject(conv, other) }

        coVerify(exactly = 0) { conversationRepo.removeConversationProject(any(), any()) }
    }

    // ─── Read-time projectName enrichment ──────────────────────────────────────

    @Test
    fun `paginated read resolves project names and leaves dangling ids null`() = runTest {
        coEvery { conversationRepo.getConversationsByCustomerPaginated(owner, 10, null) } returns
            GetCustomerConversationsResponse(
                conversations = listOf(
                    summary("conv-1", projectId = proj),
                    summary("conv-2"),
                    summary("conv-3", projectId = "PRJGONE")
                ),
                lastEvaluatedKey = "next-token"
            )
        coEvery { projectRepo.getProjects(owner) } returns listOf(project())

        val page = service.getCustomerConversationsPaginated(owner)

        val byId = page.conversations.associateBy { it.conversationId }
        assertEquals("Research", byId["conv-1"]?.projectName)
        assertNull(byId["conv-2"]?.projectName)
        assertEquals("PRJGONE", byId["conv-3"]?.projectId)
        assertNull(byId["conv-3"]?.projectName)
        assertEquals("next-token", page.lastEvaluatedKey)
    }

    @Test
    fun `pages without any project reference skip the projects query`() = runTest {
        coEvery { conversationRepo.getConversationsByCustomerPaginated(owner, 10, null) } returns
            GetCustomerConversationsResponse(
                conversations = listOf(summary("conv-1"), summary("conv-2")),
                lastEvaluatedKey = null
            )

        service.getCustomerConversationsPaginated(owner)

        coVerify(exactly = 0) { projectRepo.getProjects(any()) }
    }

    @Test
    fun `pinned list is enriched the same way`() = runTest {
        coEvery { conversationRepo.getPinnedConversationsByCustomer(owner) } returns
            listOf(summary("conv-1", projectId = proj))
        coEvery { projectRepo.getProjects(owner) } returns listOf(project())

        val pinned = service.getPinnedConversations(owner)

        assertEquals("Research", pinned.single().projectName)
    }

    @Test
    fun `pinned list without projects skips the projects query`() = runTest {
        coEvery { conversationRepo.getPinnedConversationsByCustomer(owner) } returns
            listOf(summary("conv-1"))

        service.getPinnedConversations(owner)

        coVerify(exactly = 0) { projectRepo.getProjects(any()) }
    }
}
