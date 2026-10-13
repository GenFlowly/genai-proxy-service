package com.genflowly.activity.conversation

import com.genflowly.Routes
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.StatusResponse
import com.genflowly.service.ConversationManagementService
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.ProjectNotFoundException
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("AssignConversationProjectRoute")

fun Route.registerAssignConversationProjectRoutes(
    customerProfileService: CustomerProfileService,
    conversationManagementService: ConversationManagementService
) {
    authenticate("auth0", "apiKey") {
        post(Routes.ASSIGN_CONVERSATION_PROJECT, {
            tags("Conversations")
            summary = "Put a conversation into a project"
            description = "Replaces any previous assignment, so this is also how a conversation " +
                    "moves between projects. Owner-only, like pinning."
            request {
                queryParameter<String>("conversationId") {
                    description = "Conversation to assign"
                    required = true
                }
                queryParameter<String>("projectId") {
                    description = "Target project (must exist for the caller)"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Conversation assigned to the project"
                    body<StatusResponse>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "Missing conversationId or projectId"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.Forbidden) {
                    description = "Caller does not own this conversation"
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
                val conversationId = call.request.queryParameters["conversationId"]
                val projectId = call.request.queryParameters["projectId"]

                if (conversationId.isNullOrBlank() || projectId.isNullOrBlank()) {
                    return@post call.respond(
                        HttpStatusCode.BadRequest,
                        mapOf("error" to "Missing conversationId or projectId")
                    )
                }

                conversationManagementService.assignConversationToProject(
                    conversationId = conversationId,
                    customerId = customerId,
                    projectId = projectId
                )

                call.respond(HttpStatusCode.OK, mapOf("status" to "success"))
            } catch (e: SecurityException) {
                logger.warn("Unauthorized conversation assign-project attempt: {}", e.message)
                call.respond(HttpStatusCode.Forbidden, mapOf("error" to (e.message ?: "Forbidden")))
            } catch (e: ProjectNotFoundException) {
                call.respond(HttpStatusCode.NotFound, mapOf("error" to "Project not found"))
            } catch (e: Exception) {
                logger.error("Unexpected error in Assign Conversation Project controller: {}", e.message, e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    mapOf("error" to "Internal server error: ${e.message}")
                )
            }
        }

        post(Routes.UNASSIGN_CONVERSATION_PROJECT, {
            tags("Conversations")
            summary = "Take a conversation out of its project"
            description = "The conversation returns to the global Pinned/Recents history sections. " +
                    "Owner-only, like pinning."
            request {
                queryParameter<String>("conversationId") {
                    description = "Conversation to unassign"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Conversation unassigned from its project"
                    body<StatusResponse>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "Missing conversationId"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.Forbidden) {
                    description = "Caller does not own this conversation"
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
                val conversationId = call.request.queryParameters["conversationId"]

                if (conversationId.isNullOrBlank()) {
                    return@post call.respond(
                        HttpStatusCode.BadRequest,
                        mapOf("error" to "Missing conversationId")
                    )
                }

                conversationManagementService.unassignConversationFromProject(
                    conversationId = conversationId,
                    customerId = customerId
                )

                call.respond(HttpStatusCode.OK, mapOf("status" to "success"))
            } catch (e: SecurityException) {
                logger.warn("Unauthorized conversation unassign-project attempt: {}", e.message)
                call.respond(HttpStatusCode.Forbidden, mapOf("error" to (e.message ?: "Forbidden")))
            } catch (e: Exception) {
                logger.error("Unexpected error in Unassign Conversation Project controller: {}", e.message, e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    mapOf("error" to "Internal server error: ${e.message}")
                )
            }
        }
    }
}
