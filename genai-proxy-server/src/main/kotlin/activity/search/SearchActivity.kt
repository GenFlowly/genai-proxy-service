package com.genflowly.activity.search

import com.genflowly.Routes
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.SearchResponse
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.UnifiedSearchService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("SearchRoute")

private const val DEFAULT_LIMIT = 10
private const val MAX_LIMIT = 50

fun Route.registerSearchRoutes(
    customerProfileService: CustomerProfileService,
    unifiedSearchService: UnifiedSearchService
) {
    authenticate("auth0", "apiKey") {
        get(Routes.SEARCH, {
            tags("Search")
            summary = "Semantic search across the customer's data"
            description = "Searches conversations, notes, memories and emails by meaning. " +
                    "Query parameter 'q' is required; 'limit' caps results (max $MAX_LIMIT); " +
                    "'types' optionally restricts the searched data types as a comma-separated " +
                    "list (e.g. types=conversation,notes). Returns matched items ranked by " +
                    "similarity, each with its best-matching snippet."
            response {
                code(HttpStatusCode.OK) {
                    description = "Matching items across all searched data types, best match first"
                    body<SearchResponse>()
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
                val types = call.request.queryParameters["types"]
                    ?.split(',')
                    ?.map { it.trim().lowercase() }
                    ?.filter { it.isNotBlank() }
                    ?.takeIf { it.isNotEmpty() }

                val results = unifiedSearchService.search(customerId, query, limit, types)

                call.respond(HttpStatusCode.OK, SearchResponse(results = results))
            } catch (e: Exception) {
                logger.error("Unexpected error in Search controller: {}", e.message, e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    mapOf("error" to "Internal server error: ${e.message}")
                )
            }
        }
    }
}
