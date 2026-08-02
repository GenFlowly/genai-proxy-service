package com.genflowly.activity

import com.genflowly.Routes
import com.genflowly.providers.DynamoDBProvider
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

fun Route.registerSearchRoutes(
    dynamoDBProvider: DynamoDBProvider
) {
    authenticate("auth0") {
        get(Routes.SEARCH_USERS) {
            val username = call.request.queryParameters["username"]
            if (username.isNullOrBlank()) {
                call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Missing username parameter"))
                return@get
            }
            
            try {
                val response = dynamoDBProvider.searchByUsername(username)
                call.respond(HttpStatusCode.OK, response)
            } catch (e: Exception) {
                logger.error("Failed to search by username", e)
                call.respond(HttpStatusCode.InternalServerError)
            }
        }
    }
}
