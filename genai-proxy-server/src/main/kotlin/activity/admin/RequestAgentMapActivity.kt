package com.genflowly.activity.admin

import com.genflowly.Routes
import com.genflowly.config.AppConfig
import com.genflowly.models.RequestType
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.PutRequestAgentMapRequest
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.RequestAgentMapAdminService
import com.genflowly.utils.requireAdminCustomerId
import io.github.smiley4.ktoropenapi.delete
import io.github.smiley4.ktoropenapi.get
import io.github.smiley4.ktoropenapi.put
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.SerializationException
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("RequestAgentMapActivity")

/**
 * Admin-panel endpoints for the global request-type → agent mapping. The
 * agents and instructions the map points at are created through the regular
 * customer-facing APIs (POST /v1/instruction, POST /v1/agents) — only the
 * global mapping is admin-gated. JWT-only, allowlist-gated and hidden from
 * the public OpenAPI spec, same posture as the system API key endpoints.
 */
fun Route.registerRequestAgentMapRoutes(
    requestAgentMapAdminService: RequestAgentMapAdminService,
    customerProfileService: CustomerProfileService,
    appConfig: AppConfig
) {
    authenticate("auth0") {
        get(Routes.ADMIN_REQUEST_AGENT_MAP, { hidden = true }) {
            try {
                call.requireAdminCustomerId(customerProfileService, appConfig)
                call.respond(requestAgentMapAdminService.listMapEntries())
            } catch (e: IllegalStateException) {
                // requireAdminCustomerId already responded (403)
            } catch (e: Exception) {
                logger.error("Failed to list request-agent map entries", e)
                call.respond(HttpStatusCode.InternalServerError, ErrorResponse(error = "Internal server error"))
            }
        }

        put(Routes.ADMIN_REQUEST_AGENT_MAP_ENTRY, { hidden = true }) {
            try {
                val customerId = call.requireAdminCustomerId(customerProfileService, appConfig)
                val requestType = call.parseRequestType() ?: return@put
                val request = call.receive<PutRequestAgentMapRequest>()

                try {
                    requestAgentMapAdminService.putMapEntry(requestType, request, customerId)
                } catch (e: IllegalArgumentException) {
                    return@put call.respond(
                        HttpStatusCode.BadRequest,
                        ErrorResponse(error = "Invalid mapping: ${e.message}")
                    )
                }
                call.respond(HttpStatusCode.OK, mapOf("status" to "success"))
            } catch (e: SerializationException) {
                call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "Invalid request format"))
            } catch (e: IllegalStateException) {
                // requireAdminCustomerId already responded (403)
            } catch (e: Exception) {
                logger.error("Failed to save request-agent map entry", e)
                call.respond(HttpStatusCode.InternalServerError, ErrorResponse(error = "Internal server error"))
            }
        }

        delete(Routes.ADMIN_REQUEST_AGENT_MAP_ENTRY, { hidden = true }) {
            try {
                val customerId = call.requireAdminCustomerId(customerProfileService, appConfig)
                val requestType = call.parseRequestType() ?: return@delete
                logger.info("Admin {} deleting request-agent map entry for {}", customerId, requestType)
                requestAgentMapAdminService.deleteMapEntry(requestType)
                call.respond(HttpStatusCode.NoContent)
            } catch (e: IllegalStateException) {
                // requireAdminCustomerId already responded (403)
            } catch (e: Exception) {
                logger.error("Failed to delete request-agent map entry", e)
                call.respond(HttpStatusCode.InternalServerError, ErrorResponse(error = "Internal server error"))
            }
        }
    }
}

/** Parses {requestType}, responding 400 and returning null when unknown. */
private suspend fun io.ktor.server.application.ApplicationCall.parseRequestType(): RequestType? {
    val param = parameters["requestType"]
        ?: run {
            respond(HttpStatusCode.BadRequest, ErrorResponse(error = "Missing requestType"))
            return null
        }
    return try {
        RequestType.valueOf(param)
    } catch (e: IllegalArgumentException) {
        respond(
            HttpStatusCode.BadRequest,
            ErrorResponse(error = "Unknown requestType: $param. Valid: ${RequestType.entries.joinToString()}")
        )
        null
    }
}
