package com.genflowly.activity.customer

import com.genflowly.Routes
import com.genflowly.providers.DynamoDBProvider
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import io.ktor.server.auth.jwt.JWTPrincipal
import io.ktor.server.auth.principal
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
            
            val principal = call.principal<JWTPrincipal>()
            val sub = principal?.payload?.subject ?: return@get call.respond(HttpStatusCode.Unauthorized)
            val client = "REACT_APP"
            
            try {
                val currentUserProfile = dynamoDBProvider.getCustomerProfile(sub, client)
                val currentCustomerId = currentUserProfile?.get("customerId")?.s()
                
                val response = dynamoDBProvider.searchByUsername(username)
                val filteredResponse = response.filter { it.customerId != currentCustomerId }
                
                call.respond(HttpStatusCode.OK, filteredResponse)
            } catch (e: Exception) {
                logger.error("Failed to search by username", e)
                call.respond(HttpStatusCode.InternalServerError)
            }
        }
    }
}
