package com.genflowly.service

import com.genflowly.models.api.Project
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.ProjectRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.coVerifyOrder
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/**
 * Project CRUD invariants: name validation happens before any write, rename
 * surfaces missing projects as 404s, and delete is non-destructive — it
 * unassigns every member conversation BEFORE removing the project row, so a
 * mid-crash leaves a retryable state instead of dangling projectIds.
 */
class ProjectServiceTest {

    private val cust = "cust-1"
    private val proj = "PRJ123"

    private val projectRepo = mockk<ProjectRepository>(relaxed = true)
    private val conversationRepo = mockk<ConversationRepository>(relaxed = true)
    private val cacheVersions = mockk<CacheVersionService>(relaxed = true)
    private val service = ProjectService(projectRepo, conversationRepo, cacheVersions)

    private fun project(id: String = proj, updatedAt: String = "2026-01-01T00:00:00Z") = Project(
        projectId = id, name = "Research", createdAt = "2026-01-01T00:00:00Z", updatedAt = updatedAt
    )

    @Test
    fun `create trims the name before persisting`() = runTest {
        coEvery { projectRepo.createProject(cust, "Research") } returns project()

        service.createProject(cust, "  Research  ")

        coVerify(exactly = 1) { projectRepo.createProject(cust, "Research") }
    }

    @Test
    fun `blank name is rejected without touching the repository`() = runTest {
        assertFailsWith<IllegalArgumentException> { service.createProject(cust, "   ") }

        coVerify(exactly = 0) { projectRepo.createProject(any(), any()) }
    }

    @Test
    fun `name longer than the limit is rejected on create and rename`() = runTest {
        val name = "x".repeat(ProjectService.MAX_NAME_LENGTH + 1)

        assertFailsWith<IllegalArgumentException> { service.createProject(cust, name) }
        assertFailsWith<IllegalArgumentException> { service.renameProject(cust, proj, name) }

        coVerify(exactly = 0) { projectRepo.createProject(any(), any()) }
        coVerify(exactly = 0) { projectRepo.renameProject(any(), any(), any()) }
    }

    @Test
    fun `projects list most recently updated first`() = runTest {
        coEvery { projectRepo.getProjects(cust) } returns listOf(
            project(id = "PRJOLD", updatedAt = "2026-01-01T00:00:00Z"),
            project(id = "PRJNEW", updatedAt = "2026-02-01T00:00:00Z")
        )

        val response = service.getProjects(cust)

        assertEquals(listOf("PRJNEW", "PRJOLD"), response.projects.map { it.projectId })
    }

    @Test
    fun `rename passes the trimmed name`() = runTest {
        coEvery { projectRepo.renameProject(cust, proj, "New name") } returns true

        service.renameProject(cust, proj, "  New name ")

        coVerify(exactly = 1) { projectRepo.renameProject(cust, proj, "New name") }
    }

    @Test
    fun `rename of a missing project surfaces as not found`() = runTest {
        coEvery { projectRepo.renameProject(cust, proj, any()) } returns false

        assertFailsWith<ProjectNotFoundException> { service.renameProject(cust, proj, "New name") }
    }

    @Test
    fun `delete of a missing project is not found and writes nothing`() = runTest {
        coEvery { projectRepo.getProject(cust, proj) } returns null

        assertFailsWith<ProjectNotFoundException> { service.deleteProject(cust, proj) }

        coVerify(exactly = 0) { conversationRepo.removeConversationProject(any(), any()) }
        coVerify(exactly = 0) { projectRepo.deleteProject(any(), any()) }
    }

    @Test
    fun `delete unassigns every conversation before removing the project row`() = runTest {
        coEvery { projectRepo.getProject(cust, proj) } returns project()
        coEvery { conversationRepo.getConversationIdsByProject(cust, proj) } returns listOf("conv-1", "conv-2")
        coEvery { projectRepo.deleteProject(cust, proj) } returns true

        service.deleteProject(cust, proj)

        coVerifyOrder {
            conversationRepo.removeConversationProject("conv-1", cust)
            conversationRepo.removeConversationProject("conv-2", cust)
            projectRepo.deleteProject(cust, proj)
        }
    }

    @Test
    fun `delete with no assigned conversations still removes the project`() = runTest {
        coEvery { projectRepo.getProject(cust, proj) } returns project()
        coEvery { conversationRepo.getConversationIdsByProject(cust, proj) } returns emptyList()
        coEvery { projectRepo.deleteProject(cust, proj) } returns true

        service.deleteProject(cust, proj)

        coVerify(exactly = 0) { conversationRepo.removeConversationProject(any(), any()) }
        coVerify(exactly = 1) { projectRepo.deleteProject(cust, proj) }
    }
}
