package com.genflowly.activity.conversation

import com.genflowly.Routes
import com.genflowly.models.api.CreateConversationShareRequest
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.StatusResponse
import com.genflowly.service.ConversationManagementService
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.delete
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("CreateConversationShareRoute")

fun Route.registerCreateConversationShareRoutes(
    customerProfileService: CustomerProfileService,
    conversationManagementService: ConversationManagementService
) {
    authenticate("auth0", "apiKey") {
        post(Routes.CREATE_CONVERSATION_SHARE, {
            tags("Conversations")
            summary = "Share a conversation with another user"
            description = "Grants another customer access to a conversation with the given role."
            request {
                body<CreateConversationShareRequest> {
                    description = "Conversation, target customer and role"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Conversation shared"
                    body<StatusResponse>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "Conversation is archived and cannot be shared"
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
                val request = call.receive<CreateConversationShareRequest>()

                conversationManagementService.shareConversation(
                    conversationId = request.conversationId,
                    targetCustomerId = request.targetCustomerId,
                    sharedByCustomerId = customerId,
                    role = request.role
                )

                call.respond(HttpStatusCode.OK, mapOf("status" to "success"))
            } catch (e: SecurityException) {
                logger.warn("Unauthorized conversation share attempt: {}", e.message)
                call.respond(HttpStatusCode.Forbidden, mapOf("error" to (e.message ?: "Forbidden")))
            } catch (e: com.genflowly.service.ConversationArchivedException) {
                logger.warn("Attempted to share archived conversation: {}", e.message)
                call.respond(HttpStatusCode.BadRequest, mapOf("error" to (e.message ?: "Cannot share archived conversation")))
            } catch (e: Exception) {
                logger.error("Unexpected error in Create Conversation Share controller: {}", e.message, e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    mapOf("error" to "Internal server error: ${e.message}")
                )
            }
        }

        delete(Routes.CREATE_CONVERSATION_SHARE, {
            tags("Conversations")
            summary = "Revoke a conversation share"
            description = "Removes another customer's access to a conversation."
            request {
                queryParameter<String>("conversationId") {
                    description = "Conversation to unshare"
                    required = true
                }
                queryParameter<String>("targetCustomerId") {
                    description = "Customer whose access is revoked"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Share revoked"
                    body<StatusResponse>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "Missing conversationId or targetCustomerId"
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
                val targetCustomerId = call.request.queryParameters["targetCustomerId"]

                if (conversationId == null || targetCustomerId == null) {
                    return@delete call.respond(
                        HttpStatusCode.BadRequest,
                        mapOf("error" to "Missing conversationId or targetCustomerId")
                    )
                }

                conversationManagementService.unshareConversation(
                    conversationId = conversationId,
                    targetCustomerId = targetCustomerId,
                    sharedByCustomerId = customerId
                )

                call.respond(HttpStatusCode.OK, mapOf("status" to "success"))
            } catch (e: SecurityException) {
                logger.warn("Unauthorized conversation unshare attempt: {}", e.message)
                call.respond(HttpStatusCode.Forbidden, mapOf("error" to (e.message ?: "Forbidden")))
            } catch (e: Exception) {
                logger.error("Unexpected error in Delete Conversation Share controller: {}", e.message, e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    mapOf("error" to "Internal server error: ${e.message}")
                )
            }
        }
    }
}
