package com.genflowly.activity.generation

import com.genflowly.Routes
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.PreferencesRequest
import com.genflowly.models.api.StatusResponse
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory
import com.genflowly.service.CustomerProfileService

private val logger = LoggerFactory.getLogger("SaveAIConfigPreferences")

fun Route.registerSaveAIConfigPreferencesRoutes(
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0", "apiKey") {
        post(Routes.SAVE_AI_CONFIG_PREFERENCES, {
            tags("Generation")
            summary = "Save AI configuration preferences"
            description = "Persists the customer's preferred models, generative mode and other preferences."
            request {
                body<PreferencesRequest> {
                    description = "Preferences to store"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Preferences saved"
                    body<StatusResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                    body<ErrorResponse>()
                }
            }
        }) {
            try {
                val request = call.receive<PreferencesRequest>()

                val customerId = call.requireAuthenticatedCustomerId(
                    customerProfileService
                )


                customerProfileService.savePreferences(
                    customerId,
                    request.aiConfigPreferences?.preferredModels,
                    request.aiConfigPreferences?.preferredGenerativeMode,
                    request.otherPreferences,
                    request.aiConfigPreferences?.embeddingMode,
                    request.aiConfigPreferences?.embeddingModel,
                    request.aiConfigPreferences?.preferredInstructionId,
                    request.aiConfigPreferences?.instructionFallbackMode,
                    request.aiConfigPreferences?.preferredAgentId
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