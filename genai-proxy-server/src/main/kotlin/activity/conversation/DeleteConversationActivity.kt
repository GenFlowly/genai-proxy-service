package com.genflowly.activity.conversation

import com.genflowly.Routes
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.StatusResponse
import com.genflowly.service.ConversationManagementService
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.delete
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("DeleteConversationRoute")

fun Route.registerDeleteConversationRoutes(
    customerProfileService: CustomerProfileService,
    conversationManagementService: ConversationManagementService
) {
    authenticate("auth0", "apiKey") {
        delete(Routes.DELETE_CONVERSATION, {
            tags("Conversations")
            summary = "Delete a conversation"
            description = "The owner's delete is permanent: the conversation, its messages, its shares and " +
                    "public link, its files and its vectors are deleted, and it can't be restored. Someone the " +
                    "conversation was shared with only removes it from their own history; the owner keeps it."
            request {
                pathParameter<String>("conversationId") {
                    description = "Conversation to delete"
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Conversation deleted, or removed from the caller's history"
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
                val conversationId = call.parameters["conversationId"]

                if (conversationId.isNullOrBlank()) {
                    return@delete call.respond(
                        HttpStatusCode.BadRequest,
                        mapOf("error" to "Missing conversationId")
                    )
                }

                conversationManagementService.deleteConversation(
                    conversationId = conversationId,
                    customerId = customerId
                )

                call.respond(HttpStatusCode.OK, mapOf("status" to "success"))
            } catch (e: SecurityException) {
                logger.warn("Unauthorized conversation delete attempt: {}", e.message)
                call.respond(HttpStatusCode.Forbidden, mapOf("error" to (e.message ?: "Forbidden")))
            } catch (e: Exception) {
                logger.error("Unexpected error in Delete Conversation controller: {}", e.message, e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    mapOf("error" to "Internal server error: ${e.message}")
                )
            }
        }
    }
}
