package com.genflowly.activity

import com.genflowly.Routes
import com.genflowly.models.AIConfigPreferencesRequest
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.post
import org.slf4j.LoggerFactory
import service.CustomerProfileService

private val logger = LoggerFactory.getLogger("SaveAIConfigPreferences")

fun Route.registerSaveAIConfigPreferencesRoutes(
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0") {
        post(Routes.SAVE_AI_CONFIG_PREFERENCES) {
            try {
                val request = call.receive<AIConfigPreferencesRequest>()

                val customerId = call.requireAuthenticatedCustomerId(
                    customerProfileService
                )


                customerProfileService.saveAIConfigPreferences(
                    customerId,
                    request.preferredModels,
                    request.preferredGenerativeMode,
                    request.otherPreferences
                )

                call.respond(HttpStatusCode.OK, mapOf("status" to "success"))            } catch (e: Exception) {
                logger.error(
                    "Unexpected error in SaveAIConfigPreferences controller: {}",
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