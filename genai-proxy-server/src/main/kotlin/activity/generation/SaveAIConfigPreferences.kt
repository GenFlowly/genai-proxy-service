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
import com.genflowly.service.CustomerCredentialsService
import com.genflowly.service.CustomerProfileService

private val logger = LoggerFactory.getLogger("SaveAIConfigPreferences")

fun Route.registerSaveAIConfigPreferencesRoutes(
    customerProfileService: CustomerProfileService,
    customerCredentialsService: CustomerCredentialsService
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

                // Reject embedding models the customer's key can't actually
                // encode (e.g. voyage-multimodal-*, which the picker's LiteLLM
                // catalog lists but the Voyage text-embed SDK rejects). The valid
                // set is discovered by probing the key, not a hardcoded list.
                // Without this gate the failure surfaces only days later, deep in
                // the encoding server, and silently — the whole run aborts before
                // the store step, so nothing ever reaches Milvus.
                val prefs = request.aiConfigPreferences
                try {
                    customerCredentialsService.assertEmbeddingModelSupported(customerId, prefs?.embeddingModel)
                    customerCredentialsService.assertEmbeddingModelSupported(customerId, prefs?.embeddingModelConversations)
                    customerCredentialsService.assertEmbeddingModelSupported(customerId, prefs?.embeddingModelNotes)
                } catch (e: IllegalArgumentException) {
                    logger.warn("Rejected preferences save for customer {}: {}", customerId, e.message)
                    call.respond(HttpStatusCode.BadRequest, mapOf("error" to (e.message ?: "Unsupported embedding model")))
                    return@post
                }

                customerProfileService.savePreferences(
                    customerId,
                    request.aiConfigPreferences?.preferredModels,
                    request.otherPreferences,
                    request.aiConfigPreferences?.embeddingMode,
                    request.aiConfigPreferences?.embeddingModel,
                    request.aiConfigPreferences?.embeddingModelConversations,
                    request.aiConfigPreferences?.embeddingModelNotes,
                    request.aiConfigPreferences?.preferredAgentId,
                    request.aiConfigPreferences?.memoryLearnFromChats,
                    request.aiConfigPreferences?.memoryLearnFromNotes,
                    request.aiConfigPreferences?.memoryUseInReplies
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