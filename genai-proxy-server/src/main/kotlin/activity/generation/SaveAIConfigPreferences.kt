package com.genflowly.activity.generation

import com.genflowly.Routes
import com.genflowly.models.EmbeddingModelLockedException
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
            description = "Persists the customer's preferred models, generative mode and other preferences. " +
                "The embedding model is one model for all data, chosen once: send it as embeddingModel " +
                "(embeddingModelConversations / embeddingModelNotes are read as the same choice). Saving a " +
                "different model after one was chosen returns 409 with the locked model."
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
                code(HttpStatusCode.BadRequest) {
                    description = "Unsupported embedding model, or more than one embedding model in one request"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.Conflict) {
                    description = "The embedding model is already chosen and locked; the body names it (embeddingModel)"
                    body<ErrorResponse>()
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
                val requestedEmbeddingModels = listOfNotNull(
                    prefs?.embeddingModel, prefs?.embeddingModelConversations, prefs?.embeddingModelNotes
                ).map { it.trim() }.filter { it.isNotEmpty() }.distinct()
                if (requestedEmbeddingModels.size > 1) {
                    call.respond(
                        HttpStatusCode.BadRequest,
                        mapOf("error" to "One embedding model is used for all data; send a single embeddingModel.")
                    )
                    return@post
                }
                val embeddingModel = requestedEmbeddingModels.singleOrNull()
                try {
                    customerCredentialsService.assertEmbeddingModelSupported(customerId, embeddingModel)
                } catch (e: IllegalArgumentException) {
                    logger.warn("Rejected preferences save for customer {}: {}", customerId, e.message)
                    call.respond(HttpStatusCode.BadRequest, mapOf("error" to (e.message ?: "Unsupported embedding model")))
                    return@post
                }

                try {
                    saveWithLockRecovery(customerProfileService, customerCredentialsService, customerId, request, embeddingModel)
                } catch (e: EmbeddingModelLockedException) {
                    call.respond(
                        HttpStatusCode.Conflict,
                        mapOf(
                            "error" to "The embedding model is locked and can't be changed.",
                            "embeddingModel" to (e.lockedModel ?: "")
                        )
                    )
                    return@post
                }

                call.respond(HttpStatusCode.OK, mapOf("status" to "success"))
            } catch (e: Exception) {
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

/**
 * Saves the preferences. A locked embedding model the key can no longer
 * embed with (picked before models were probed) would strand the customer,
 * so it is replaced once and the save retried; any other lock refusal is
 * rethrown for the route to answer 409.
 */
private suspend fun saveWithLockRecovery(
    customerProfileService: CustomerProfileService,
    customerCredentialsService: CustomerCredentialsService,
    customerId: String,
    request: PreferencesRequest,
    embeddingModel: String?
) {
    val prefs = request.aiConfigPreferences
    val save: suspend () -> Unit = {
        customerProfileService.savePreferences(
            customerId,
            prefs?.preferredModels,
            request.otherPreferences,
            prefs?.embeddingMode,
            embeddingModel,
            prefs?.preferredAgentId,
            prefs?.memoryLearnFromChats,
            prefs?.memoryLearnFromNotes,
            prefs?.memoryUseInReplies,
            prefs?.indexChats
        )
    }
    try {
        save()
    } catch (e: EmbeddingModelLockedException) {
        val locked = e.lockedModel
        if (embeddingModel == null || locked == null ||
            !customerCredentialsService.isEmbeddingModelUnusable(customerId, locked)
        ) throw e
        customerProfileService.replaceUnusableEmbeddingModel(customerId, locked, embeddingModel)
        save()
    }
}
