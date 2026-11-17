package com.genflowly.activity.developer

import com.genflowly.Routes
import com.genflowly.models.api.CreateDeveloperApiKeyRequest
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.DeveloperApiKeyUsageTotals
import com.genflowly.models.api.ListDeveloperApiKeysResponse
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.DeveloperApiKeyService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.delete
import io.github.smiley4.ktoropenapi.get
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.SerializationException
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("DeveloperApiKeysActivity")

/**
 * Management endpoints for developer API keys.
 *
 * Deliberately JWT-only (an API key must never be able to mint or revoke keys)
 * and hidden from the OpenAPI spec — key management happens in the web app's
 * Settings → Developer page, not through the public API surface.
 */
fun Route.registerDeveloperApiKeysRoutes(
    developerApiKeyService: DeveloperApiKeyService,
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0") {
        post(Routes.DEVELOPER_API_KEYS, { hidden = true }) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val request = call.receive<CreateDeveloperApiKeyRequest>()

                val name = request.name.trim()
                if (name.isEmpty() || name.length > 100) {
                    call.respond(
                        HttpStatusCode.BadRequest,
                        ErrorResponse(error = "Key name must be between 1 and 100 characters")
                    )
                    return@post
                }

                val response = developerApiKeyService.createKey(customerId, name)
                call.respond(response)
            } catch (e: SerializationException) {
                call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "Invalid request format"))
            } catch (e: Exception) {
                logger.error("Failed to create developer API key", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ErrorResponse(error = "Internal server error")
                )
            }
        }

        get(Routes.DEVELOPER_API_KEYS, { hidden = true }) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val keys = developerApiKeyService.listKeys(customerId)
                call.respond(ListDeveloperApiKeysResponse(keys = keys, totals = DeveloperApiKeyUsageTotals.of(keys)))
            } catch (e: Exception) {
                logger.error("Failed to list developer API keys", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ErrorResponse(error = "Internal server error")
                )
            }
        }

        delete(Routes.DEVELOPER_API_KEY, { hidden = true }) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val keyId = call.parameters["keyId"]
                    ?: return@delete call.respond(
                        HttpStatusCode.BadRequest,
                        ErrorResponse(error = "Missing keyId")
                    )

                val deleted = developerApiKeyService.revokeKey(customerId, keyId)
                if (deleted) {
                    call.respond(HttpStatusCode.NoContent)
                } else {
                    call.respond(HttpStatusCode.NotFound, ErrorResponse(error = "API key not found"))
                }
            } catch (e: Exception) {
                logger.error("Failed to revoke developer API key", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ErrorResponse(error = "Internal server error")
                )
            }
        }
    }
}
