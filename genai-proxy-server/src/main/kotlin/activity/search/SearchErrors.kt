package com.genflowly.activity.search

import com.genflowly.models.api.SearchErrorResponse
import com.genflowly.providers.SearchNotConfiguredException
import com.genflowly.providers.SearchUnavailableException
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.response.respond

/**
 * Answers a search that couldn't run — 409 when the customer is missing a
 * setting, 502 when the retrieval-server failed — and returns true, or
 * returns false for any other exception so the route handles it as before.
 */
suspend fun ApplicationCall.respondSearchFailure(e: Exception): Boolean = when (e) {
    is SearchNotConfiguredException -> {
        respond(
            HttpStatusCode.Conflict,
            SearchErrorResponse(
                error = e.message ?: "Search is not set up",
                code = SearchErrorResponse.NOT_CONFIGURED,
                reason = e.reason.code
            )
        )
        true
    }
    is SearchUnavailableException -> {
        respond(
            HttpStatusCode.BadGateway,
            SearchErrorResponse(error = "Search is unavailable", code = SearchErrorResponse.UNAVAILABLE)
        )
        true
    }
    else -> false
}
