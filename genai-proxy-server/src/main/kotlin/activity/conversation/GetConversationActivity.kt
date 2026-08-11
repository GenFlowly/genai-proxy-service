package com.genflowly.activity.conversation

import com.genflowly.Routes
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.GetConversationResponse
import io.github.smiley4.ktoropenapi.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.ConversationService
import com.genflowly.service.ConversationAccessDeniedException
import com.genflowly.utils.getAuthenticatedCustomerId

private val logger = LoggerFactory.getLogger("GetConversationRoute")



fun Route.registerGetConversationRoutes(
    customerProfileService: CustomerProfileService,
    conversationService: ConversationService
) {
    authenticate("auth0", optional = true) {
        get("${Routes.GET_CONVERSATION}/{conversationId}", {
            tags("Conversations")
            summary = "Get conversation history"
            description = "Returns the full message history of a conversation. Authentication is " +
                    "optional: unauthenticated callers can only access publicly shared conversations."
            request {
                pathParameter<String>("conversationId") {
                    description = "Conversation to fetch"
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Conversation history"
                    body<GetConversationResponse>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "Missing conversationId"
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
                val conversationId = call.parameters["conversationId"]

                // TODO think about it
                if (conversationId.isNullOrBlank()) {
                    call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Missing conversationId"))
                    return@get
                }

                val customerId = call.getAuthenticatedCustomerId(customerProfileService) ?: "PUBLIC"

                val response = conversationService.getConversationHistory(conversationId, customerId)
                call.respond(response)

            } catch (e: ConversationAccessDeniedException) {
                call.respond(HttpStatusCode.Forbidden, mapOf("error" to "Access denied"))
            } catch (e: Exception) {
                logger.error(
                    "Unexpected error in Get Conversation controller: {}",
                    e.message,
                    e
                )
                call.respond(
                    HttpStatusCode.InternalServerError,
                    mapOf("error" to "Internal server error: ${e.message}")
                )
            }
        }
    }
}