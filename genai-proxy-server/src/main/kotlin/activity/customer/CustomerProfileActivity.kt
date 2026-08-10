package com.genflowly.activity.customer

import com.genflowly.Routes
import com.genflowly.models.api.UpdateUsernameRequest
import com.genflowly.models.api.UpdateDiscoverabilityRequest
import com.genflowly.providers.DynamoDBProvider
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.auth.jwt.JWTPrincipal
import io.ktor.server.auth.principal
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.post
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

fun Route.registerCustomerProfileSettingsRoutes(
    dynamoDBProvider: DynamoDBProvider
) {
    authenticate("auth0") {
        post(Routes.UPDATE_USERNAME) {
            val principal = call.principal<JWTPrincipal>()
            val sub = principal?.payload?.subject ?: return@post call.respond(HttpStatusCode.Unauthorized)
            val client = "REACT_APP"
            
            val request = call.receive<UpdateUsernameRequest>()
            
            try {
                val profile = dynamoDBProvider.getCustomerProfile(sub, client)
                if (profile == null) {
                    call.respond(HttpStatusCode.NotFound, "Profile not found")
                    return@post
                }
                
                val customerId = profile["customerId"]?.s() ?: return@post call.respond(HttpStatusCode.InternalServerError)
                val oldUsername = profile["username"]?.s()
                
                dynamoDBProvider.updateUsername(sub, client, customerId, oldUsername, request.username)
                call.respond(HttpStatusCode.OK, mapOf("success" to true))
            } catch (e: IllegalArgumentException) {
                call.respond(HttpStatusCode.Conflict, mapOf("error" to "Username is already taken"))
            } catch (e: Exception) {
                logger.error("Failed to update username", e)
                call.respond(HttpStatusCode.InternalServerError)
            }
        }

        post(Routes.UPDATE_DISCOVERABILITY) {
            val principal = call.principal<JWTPrincipal>()
            val sub = principal?.payload?.subject ?: return@post call.respond(HttpStatusCode.Unauthorized)
            val client = "REACT_APP"
            
            val request = call.receive<UpdateDiscoverabilityRequest>()
            
            try {
                dynamoDBProvider.updateDiscoverability(sub, client, request.isDiscoverable)
                call.respond(HttpStatusCode.OK, mapOf("success" to true))
            } catch (e: Exception) {
                logger.error("Failed to update discoverability", e)
                call.respond(HttpStatusCode.InternalServerError)
            }
        }
    }
}
