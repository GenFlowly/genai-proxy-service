package com.genflowly.activity.conversation

import com.genflowly.Routes
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.ForkConversationResponse
import com.genflowly.service.ConversationAccessDeniedException
import com.genflowly.service.ConversationManagementService
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.bearerToken
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("ForkConversationRoute")

fun Route.registerForkConversationRoutes(
    customerProfileService: CustomerProfileService,
    conversationManagementService: ConversationManagementService
) {
    authenticate("auth0", "apiKey") {
        post(Routes.FORK_CONVERSATION, {
            tags("Conversations")
            summary = "Fork a conversation at a message"
            description = "Creates a new conversation owned by the caller containing a copy of " +
                    "every message up to and including the given message — nothing after it. " +
                    "The new conversation is titled \"Forked <source title>\" and records the " +
                    "source as its parent so clients can render the fork tree."
            request {
                queryParameter<String>("conversationId") {
                    description = "Conversation to fork"
                    required = true
                }
                queryParameter<String>("messageId") {
                    description = "Fork point: the last message (inclusive) copied into the fork"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "The newly created forked conversation"
                    body<ForkConversationResponse>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "Missing conversationId/messageId, or the message is not in the conversation"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.Forbidden) {
                    description = "Caller does not have access to this conversation"
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
                val messageId = call.request.queryParameters["messageId"]

                if (conversationId.isNullOrBlank() || messageId.isNullOrBlank()) {
                    return@post call.respond(
                        HttpStatusCode.BadRequest,
                        mapOf("error" to "Missing conversationId or messageId")
                    )
                }

                val response = conversationManagementService.forkConversation(
                    conversationId = conversationId,
                    forkAtMessageId = messageId,
                    callerCustomerId = customerId,
                    bearerToken = call.bearerToken()
                )

                call.respond(HttpStatusCode.OK, response)
            } catch (e: ConversationAccessDeniedException) {
                call.respond(HttpStatusCode.Forbidden, mapOf("error" to "Access denied"))
            } catch (e: IllegalArgumentException) {
                call.respond(HttpStatusCode.BadRequest, mapOf("error" to (e.message ?: "Invalid request")))
            } catch (e: Exception) {
                logger.error("Unexpected error in Fork Conversation controller: {}", e.message, e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    mapOf("error" to "Internal server error: ${e.message}")
                )
            }
        }
    }
}
