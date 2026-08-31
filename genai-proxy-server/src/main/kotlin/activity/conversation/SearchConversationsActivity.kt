package com.genflowly.activity.conversation

import com.genflowly.Routes
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.SearchConversationsResponse
import com.genflowly.service.ConversationSearchService
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("SearchConversationsRoute")

private const val DEFAULT_LIMIT = 10
private const val MAX_LIMIT = 50

fun Route.registerSearchConversationsRoutes(
    customerProfileService: CustomerProfileService,
    conversationSearchService: ConversationSearchService
) {
    authenticate("auth0", "apiKey") {
        get(Routes.SEARCH_CONVERSATIONS, {
            tags("Conversations")
            summary = "Semantically search conversations"
            description = "Searches the customer's conversations by meaning (query parameter 'q', " +
                    "optional 'limit', max $MAX_LIMIT). Returns matching conversations ranked by " +
                    "similarity, each with its best-matching snippet."
            response {
                code(HttpStatusCode.OK) {
                    description = "Matching conversations, best match first"
                    body<SearchConversationsResponse>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "Missing or blank 'q' query parameter"
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

                val query = call.request.queryParameters["q"]?.trim()
                if (query.isNullOrBlank()) {
                    call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Query parameter 'q' is required"))
                    return@get
                }
                val limit = (call.request.queryParameters["limit"]?.toIntOrNull() ?: DEFAULT_LIMIT)
                    .coerceIn(1, MAX_LIMIT)

                val results = conversationSearchService.searchConversations(customerId, query, limit)

                call.respond(HttpStatusCode.OK, SearchConversationsResponse(results = results))
            } catch (e: Exception) {
                logger.error("Unexpected error in Search Conversations controller: {}", e.message, e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    mapOf("error" to "Internal server error: ${e.message}")
                )
            }
        }
    }
}
