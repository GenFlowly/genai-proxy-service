package com.genflowly.activity.agent

import com.genflowly.Routes
import com.genflowly.models.RequestType
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.GetCustomerRequestAgentsResponse
import com.genflowly.models.api.PutCustomerRequestAgentRequest
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.CustomerRequestAgentMapService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.delete
import io.github.smiley4.ktoropenapi.get
import io.github.smiley4.ktoropenapi.put
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.SerializationException
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("CustomerRequestAgentsActivity")

private suspend fun ApplicationCall.parseRequestTypeOrRespond(): RequestType? {
    val raw = parameters["requestType"] ?: run {
        respond(HttpStatusCode.BadRequest, ErrorResponse(error = "Missing requestType"))
        return null
    }
    return runCatching { RequestType.valueOf(raw) }.getOrElse {
        respond(
            HttpStatusCode.BadRequest,
            ErrorResponse(error = "Unknown requestType '$raw' — one of ${RequestType.entries.map { it.name }}")
        )
        null
    }
}

/**
 * Customer-facing default-action overrides: each user can point the internal
 * request types (titles, persona, memory extraction) at one of their own
 * agents. Same table as the admin SYSTEM map, scoped to the customerId —
 * their entry wins over the SYSTEM mapping for their requests only.
 */
fun Route.registerCustomerRequestAgentRoutes(
    customerRequestAgentMapService: CustomerRequestAgentMapService,
    customerProfileService: CustomerProfileService,
) {
    authenticate("auth0", "apiKey") {
        get(Routes.REQUEST_AGENT_MAP, {
            tags("Agents")
            summary = "List default actions and this account's agent overrides"
            response {
                code(HttpStatusCode.OK) { body<GetCustomerRequestAgentsResponse>() }
            }
        }) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                call.respond(customerRequestAgentMapService.listEntries(customerId))
            } catch (e: Exception) {
                logger.error("Failed to list customer request-agent entries", e)
                call.respond(HttpStatusCode.InternalServerError, ErrorResponse(error = "Internal server error"))
            }
        }

        put(Routes.REQUEST_AGENT_MAP_ENTRY, {
            tags("Agents")
            summary = "Map a default action to one of this account's agents"
            request {
                pathParameter<String>("requestType") { description = "Action to override" }
                body<PutCustomerRequestAgentRequest> { required = true }
            }
            response {
                code(HttpStatusCode.OK) { description = "Override saved" }
                code(HttpStatusCode.BadRequest) { body<ErrorResponse>() }
            }
        }) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val requestType = call.parseRequestTypeOrRespond() ?: return@put
                val request = call.receive<PutCustomerRequestAgentRequest>()
                try {
                    customerRequestAgentMapService.putEntry(customerId, requestType, request)
                } catch (e: IllegalArgumentException) {
                    return@put call.respond(
                        HttpStatusCode.BadRequest,
                        ErrorResponse(error = "Invalid mapping: ${e.message}")
                    )
                }
                call.respond(HttpStatusCode.OK, mapOf("status" to "success"))
            } catch (e: SerializationException) {
                call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "Invalid request format"))
            } catch (e: Exception) {
                logger.error("Failed to save customer request-agent entry", e)
                call.respond(HttpStatusCode.InternalServerError, ErrorResponse(error = "Internal server error"))
            }
        }

        delete(Routes.REQUEST_AGENT_MAP_ENTRY, {
            tags("Agents")
            summary = "Remove this account's override for a default action"
            request {
                pathParameter<String>("requestType") { description = "Action to reset" }
            }
            response {
                code(HttpStatusCode.NoContent) { description = "Override removed" }
            }
        }) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val requestType = call.parseRequestTypeOrRespond() ?: return@delete
                customerRequestAgentMapService.deleteEntry(customerId, requestType)
                call.respond(HttpStatusCode.NoContent)
            } catch (e: Exception) {
                logger.error("Failed to delete customer request-agent entry", e)
                call.respond(HttpStatusCode.InternalServerError, ErrorResponse(error = "Internal server error"))
            }
        }
    }
}
