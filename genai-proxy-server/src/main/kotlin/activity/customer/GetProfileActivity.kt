package com.genflowly.activity

import com.genflowly.Routes
import com.genflowly.models.api.CustomerProfileResponse
import com.genflowly.providers.DynamoDBProvider
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.auth.jwt.JWTPrincipal
import io.ktor.server.auth.principal
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

fun Route.registerGetProfileRoutes(
    dynamoDBProvider: DynamoDBProvider
) {
    authenticate("auth0") {
        get(Routes.GET_PROFILE) {
            val principal = call.principal<JWTPrincipal>()
            val sub = principal?.payload?.subject ?: return@get call.respond(HttpStatusCode.Unauthorized)
            val client = "REACT_APP"
            
            try {
                val profile = dynamoDBProvider.getCustomerProfile(sub, client)
                if (profile == null) {
                    call.respond(HttpStatusCode.NotFound, mapOf("error" to "Profile not found"))
                    return@get
                }
                
                val response = CustomerProfileResponse(
                    customerId = profile["customerId"]?.s() ?: "",
                    name = profile["name"]?.s(),
                    email = profile["email"]?.s(),
                    username = profile["username"]?.s(),
                    picture = profile["picture"]?.s(),
                    isDiscoverable = profile["isDiscoverable"]?.bool() ?: false
                )
                call.respond(HttpStatusCode.OK, response)
            } catch (e: Exception) {
                logger.error("Failed to get profile", e)
                call.respond(HttpStatusCode.InternalServerError)
            }
        }
    }
}
