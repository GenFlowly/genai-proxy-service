package com.genflowly.models.api

import kotlinx.serialization.Serializable

/**
 * A customer-owned project grouping conversations in the history sidebar.
 * Deleting a project unassigns its conversations; it never deletes them.
 */
@Serializable
data class Project(
    val projectId: String,
    val name: String,
    val createdAt: String,
    val updatedAt: String
)

@Serializable
data class CreateProjectRequest(val name: String)

@Serializable
data class RenameProjectRequest(val name: String)

@Serializable
data class GetProjectsResponse(val projects: List<Project>)
