package com.genflowly.activity.conversation

import com.genflowly.Routes
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.StatusResponse
import com.genflowly.service.ConversationService
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("MarkConversationReadRoute")

fun Route.registerMarkConversationReadRoutes(
    customerProfileService: CustomerProfileService,
    conversationService: ConversationService
) {
    authenticate("auth0", "apiKey") {
        post(Routes.MARK_CONVERSATION_READ, {
            tags("Conversations")
            summary = "Mark a conversation read"
            description = "Clears the conversation's unread dot in the history list: its owner " +
                    "has seen its latest reply. A no-op for anyone but the owner."
            request {
                queryParameter<String>("conversationId") {
                    description = "Conversation the owner has read"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Marked read, or nothing to mark for this caller"
                    body<StatusResponse>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "Missing conversationId"
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
                    return@post call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Missing conversationId"))
                }
                conversationService.markConversationRead(customerId, conversationId)
                call.respond(HttpStatusCode.OK, mapOf("status" to "success"))
            } catch (e: Exception) {
                logger.error("Unexpected error in Mark Conversation Read controller: {}", e.message, e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to "Internal server error: ${e.message}"))
            }
        }
    }
}
