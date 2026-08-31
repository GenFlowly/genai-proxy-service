package com.genflowly.activity.conversation

import com.genflowly.Routes
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.GetPinnedConversationsResponse
import com.genflowly.service.ConversationManagementService
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("GetPinnedConversationsRoute")

fun Route.registerGetPinnedConversationsRoutes(
    customerProfileService: CustomerProfileService,
    conversationManagementService: ConversationManagementService
) {
    authenticate("auth0", "apiKey") {
        get(Routes.GET_PINNED_CONVERSATIONS, {
            tags("Conversations")
            summary = "List pinned conversations"
            description = "Returns the customer's pinned conversations, most recently pinned first."
            response {
                code(HttpStatusCode.OK) {
                    description = "The customer's pinned conversations"
                    body<GetPinnedConversationsResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                    body<ErrorResponse>()
                }
            }
        }) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)

                val conversations = conversationManagementService.getPinnedConversations(customerId)

                call.respond(HttpStatusCode.OK, GetPinnedConversationsResponse(conversations = conversations))
            } catch (e: Exception) {
                logger.error("Unexpected error in Get Pinned Conversations controller: {}", e.message, e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    mapOf("error" to "Internal server error: ${e.message}")
                )
            }
        }
    }
}
