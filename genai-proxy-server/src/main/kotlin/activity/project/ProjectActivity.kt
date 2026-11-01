package com.genflowly.activity.project

import com.genflowly.Routes
import com.genflowly.models.api.CreateProjectRequest
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.GetProjectsResponse
import com.genflowly.models.api.Project
import com.genflowly.models.api.RenameProjectRequest
import com.genflowly.models.api.GetCustomerConversationsResponse
import com.genflowly.models.api.StatusResponse
import com.genflowly.service.ConversationManagementService
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.ProjectNotFoundException
import com.genflowly.service.ProjectService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.delete
import io.github.smiley4.ktoropenapi.get
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("ProjectActivity")

fun Route.registerProjectRoutes(
    projectService: ProjectService,
    customerProfileService: CustomerProfileService,
    conversationManagementService: ConversationManagementService
) {
    authenticate("auth0", "apiKey") {
        post(Routes.CREATE_PROJECT, {
            tags("Projects")
            summary = "Create a project"
            description = "Creates a project grouping conversations in the history sidebar. " +
                    "Conversations join it via /conversation/assign-project or by passing " +
                    "projectId when their first message is generated."
            request {
                body<CreateProjectRequest> {
                    description = "Project name (trimmed; 1-${ProjectService.MAX_NAME_LENGTH} characters)"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "The created project"
                    body<Project>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "Blank or too-long project name"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                    body<ErrorResponse>()
                }
            }
        }) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val request = call.receive<CreateProjectRequest>()
                val project = projectService.createProject(customerId, request.name)
                call.respond(HttpStatusCode.OK, project)
            } catch (e: IllegalArgumentException) {
                call.respond(HttpStatusCode.BadRequest, mapOf("error" to (e.message ?: "Invalid project name")))
            } catch (e: Exception) {
                logger.error("Unexpected error creating project: {}", e.message, e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    mapOf("error" to "Internal server error: ${e.message}")
                )
            }
        }

        get(Routes.GET_PROJECT_CONVERSATIONS, {
            tags("Projects")
            summary = "List a project's conversations"
            description = "One page of the project's conversations, most recently updated first, " +
                    "read via the sparse projectIndex GSI. A page can come back shorter than " +
                    "pageSize (archived members are dropped after the index read) — follow " +
                    "lastEvaluatedKey, not the page length, to know when the project is exhausted."
            request {
                queryParameter<String>("projectId") {
                    description = "Project whose conversations to list"
                    required = true
                }
                queryParameter<Int>("pageSize") {
                    description = "Page size, 1-50 (default 50)"
                    required = false
                }
                queryParameter<String>("lastEvaluatedKey") {
                    description = "Pagination cursor returned by the previous page"
                    required = false
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "One page of the project's conversations plus the cursor for the next page"
                    body<GetCustomerConversationsResponse>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "Missing projectId"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                    body<ErrorResponse>()
                }
            }
        }) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val projectId = call.request.queryParameters["projectId"]?.takeIf { it.isNotBlank() }
                if (projectId == null) {
                    call.respond(HttpStatusCode.BadRequest, mapOf("error" to "projectId is required"))
                    return@get
                }
                val pageSize = (call.request.queryParameters["pageSize"]?.toIntOrNull() ?: 50).coerceIn(1, 50)
                val exclusiveStartKey = call.request.queryParameters["lastEvaluatedKey"]?.takeIf { it.isNotBlank() }

                call.respond(
                    HttpStatusCode.OK,
                    conversationManagementService.getProjectConversations(
                        customerId = customerId,
                        projectId = projectId,
                        pageSize = pageSize,
                        exclusiveStartKey = exclusiveStartKey
                    )
                )
            } catch (e: Exception) {
                logger.error("Unexpected error listing project conversations: {}", e.message, e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    mapOf("error" to "Internal server error: ${e.message}")
                )
            }
        }

        get(Routes.GET_PROJECTS, {
            tags("Projects")
            summary = "List the caller's projects"
            description = "Every project owned by the caller, most recently updated first. " +
                    "Pass pageSize for cursor-paginated reads (projectId order)."
            request {
                queryParameter<Int>("pageSize") {
                    description = "Page size, 1-100; omit for the full recency-ordered list"
                    required = false
                }
                queryParameter<String>("lastEvaluatedKey") {
                    description = "Pagination cursor returned by the previous page"
                    required = false
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "The caller's projects"
                    body<GetProjectsResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                    body<ErrorResponse>()
                }
            }
        }) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val pageSize = call.request.queryParameters["pageSize"]?.toIntOrNull()?.coerceIn(1, 100)
                val exclusiveStartKey = call.request.queryParameters["lastEvaluatedKey"]?.takeIf { it.isNotBlank() }
                call.respond(HttpStatusCode.OK, projectService.getProjects(customerId, pageSize, exclusiveStartKey))
            } catch (e: Exception) {
                logger.error("Unexpected error listing projects: {}", e.message, e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    mapOf("error" to "Internal server error: ${e.message}")
                )
            }
        }

        post(Routes.RENAME_PROJECT, {
            tags("Projects")
            summary = "Rename a project"
            description = "Conversation summaries resolve the project name at read time, " +
                    "so the new name shows up in the history sidebar immediately."
            request {
                queryParameter<String>("projectId") {
                    description = "Project to rename"
                    required = true
                }
                body<RenameProjectRequest> {
                    description = "New name (trimmed; 1-${ProjectService.MAX_NAME_LENGTH} characters)"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Project renamed"
                    body<StatusResponse>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "Missing projectId, or blank/too-long name"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.NotFound) {
                    description = "Project does not exist for the caller"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                    body<ErrorResponse>()
                }
            }
        }) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val projectId = call.request.queryParameters["projectId"]
                if (projectId.isNullOrBlank()) {
                    return@post call.respond(
                        HttpStatusCode.BadRequest,
                        mapOf("error" to "Missing projectId")
                    )
                }
                val request = call.receive<RenameProjectRequest>()
                projectService.renameProject(customerId, projectId, request.name)
                call.respond(HttpStatusCode.OK, mapOf("status" to "success"))
            } catch (e: IllegalArgumentException) {
                call.respond(HttpStatusCode.BadRequest, mapOf("error" to (e.message ?: "Invalid project name")))
            } catch (e: ProjectNotFoundException) {
                call.respond(HttpStatusCode.NotFound, mapOf("error" to "Project not found"))
            } catch (e: Exception) {
                logger.error("Unexpected error renaming project: {}", e.message, e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    mapOf("error" to "Internal server error: ${e.message}")
                )
            }
        }

        delete(Routes.DELETE_PROJECT, {
            tags("Projects")
            summary = "Delete a project"
            description = "Non-destructive for conversations: every conversation in the project " +
                    "is unassigned (it returns to the global history sections) and only the " +
                    "project itself is deleted."
            request {
                queryParameter<String>("projectId") {
                    description = "Project to delete"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Project deleted; its conversations were unassigned"
                    body<StatusResponse>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "Missing projectId"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.NotFound) {
                    description = "Project does not exist for the caller"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                    body<ErrorResponse>()
                }
            }
        }) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val projectId = call.request.queryParameters["projectId"]
                if (projectId.isNullOrBlank()) {
                    return@delete call.respond(
                        HttpStatusCode.BadRequest,
                        mapOf("error" to "Missing projectId")
                    )
                }
                projectService.deleteProject(customerId, projectId)
                call.respond(HttpStatusCode.OK, mapOf("status" to "success"))
            } catch (e: ProjectNotFoundException) {
                call.respond(HttpStatusCode.NotFound, mapOf("error" to "Project not found"))
            } catch (e: Exception) {
                logger.error("Unexpected error deleting project: {}", e.message, e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    mapOf("error" to "Internal server error: ${e.message}")
                )
            }
        }
    }
}
