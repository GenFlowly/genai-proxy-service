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
            description = "Returns the customer's pinned conversations, most recently pinned first, with cursor-based pagination."
            request {
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
                    description = "One page of pinned conversations plus the cursor for the next page"
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

                val pageSize = (call.request.queryParameters["pageSize"]?.toIntOrNull() ?: 50).coerceIn(1, 50)
                val exclusiveStartKey = call.request.queryParameters["lastEvaluatedKey"]?.takeIf { it.isNotBlank() }

                val response = conversationManagementService.getPinnedConversations(
                    customerId = customerId,
                    pageSize = pageSize,
                    exclusiveStartKey = exclusiveStartKey
                )

                call.respond(HttpStatusCode.OK, response)
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
