package com.genflowly.service

import com.genflowly.models.api.GetProjectsResponse
import com.genflowly.models.api.Project
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.ProjectRepository
import org.slf4j.LoggerFactory

class ProjectNotFoundException(projectId: String) : Exception("Project $projectId not found")

/**
 * Project CRUD for the history sidebar's Projects section. Membership (which
 * conversation sits in which project) is written on Conversation rows and
 * managed by ConversationManagementService; this service owns the project
 * entities themselves — including delete, which unassigns the project's
 * conversations rather than deleting them.
 */
class ProjectService(
    private val projectRepository: ProjectRepository,
    private val conversationRepository: ConversationRepository
) {
    private val logger = LoggerFactory.getLogger(ProjectService::class.java)

    suspend fun createProject(customerId: String, name: String): Project =
        projectRepository.createProject(customerId, validateName(name))

    suspend fun getProjects(customerId: String): GetProjectsResponse =
        GetProjectsResponse(
            projects = projectRepository.getProjects(customerId).sortedByDescending { it.updatedAt }
        )

    suspend fun renameProject(customerId: String, projectId: String, name: String) {
        val renamed = projectRepository.renameProject(customerId, projectId, validateName(name))
        if (!renamed) {
            throw ProjectNotFoundException(projectId)
        }
    }

    /**
     * Non-destructive delete: every conversation in the project is unassigned
     * (it falls back to the global history sections), then the project row
     * goes. Unassign-first means a mid-crash leaves a retryable state — the
     * project still exists with fewer members — never dangling projectIds.
     */
    suspend fun deleteProject(customerId: String, projectId: String) {
        projectRepository.getProject(customerId, projectId)
            ?: throw ProjectNotFoundException(projectId)
        val assigned = conversationRepository.getConversationIdsByProject(customerId, projectId)
        assigned.forEach { conversationRepository.removeConversationProject(it, customerId) }
        if (assigned.isNotEmpty()) {
            logger.info("Unassigned ${assigned.size} conversations while deleting project $projectId")
        }
        projectRepository.deleteProject(customerId, projectId)
    }

    private fun validateName(name: String): String {
        val trimmed = name.trim()
        require(trimmed.isNotEmpty()) { "Project name must not be blank" }
        require(trimmed.length <= MAX_NAME_LENGTH) { "Project name must be at most $MAX_NAME_LENGTH characters" }
        return trimmed
    }

    companion object {
        const val MAX_NAME_LENGTH = 100
    }
}
