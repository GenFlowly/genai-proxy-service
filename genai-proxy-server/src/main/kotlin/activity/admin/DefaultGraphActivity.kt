package com.genflowly.activity.admin

import com.genflowly.Routes
import com.genflowly.config.AppConfig
import com.genflowly.models.api.CreateGraphAgentRequest
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.UpdateAgentRequest
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.GraphService
import com.genflowly.utils.requireAdminCustomerId
import io.github.smiley4.ktoropenapi.get
import io.github.smiley4.ktoropenapi.post
import io.github.smiley4.ktoropenapi.put
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.SerializationException
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("DefaultGraphActivity")

/**
 * Admin management of the System-published default graph — the graph served to
 * every customer without an own default graph. There is no per-customer
 * seeding: publishing/updating here takes effect immediately for all
 * non-forked customers. JWT-only, allowlist-gated and hidden from the public
 * OpenAPI spec, same posture as the request-agent map endpoints.
 */
fun Route.registerDefaultGraphRoutes(
    graphService: GraphService,
    customerProfileService: CustomerProfileService,
    appConfig: AppConfig,
) {
    authenticate("auth0") {
        get(Routes.ADMIN_DEFAULT_GRAPH, { hidden = true }) {
            try {
                call.requireAdminCustomerId(customerProfileService, appConfig)
                val agent = graphService.getSystemDefaultAgentOrNull()
                if (agent == null) {
                    call.respond(
                        HttpStatusCode.NotFound,
                        ErrorResponse(error = "No System default graph is published yet.")
                    )
                } else {
                    call.respond(agent)
                }
            } catch (e: IllegalStateException) {
                // requireAdminCustomerId already responded (403)
            } catch (e: Exception) {
                logger.error("Failed to get System default graph", e)
                call.respond(HttpStatusCode.InternalServerError, ErrorResponse(error = "Internal server error"))
            }
        }

        post(Routes.ADMIN_DEFAULT_GRAPH, { hidden = true }) {
            try {
                val customerId = call.requireAdminCustomerId(customerProfileService, appConfig)
                val req = call.receive<CreateGraphAgentRequest>()
                try {
                    logger.info("Admin {} publishing the System default graph", customerId)
                    call.respond(graphService.publishSystemDefaultGraph(req))
                } catch (e: IllegalArgumentException) {
                    call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "${e.message}"))
                }
            } catch (e: SerializationException) {
                call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "Invalid request format"))
            } catch (e: IllegalStateException) {
                // requireAdminCustomerId already responded (403)
            } catch (e: Exception) {
                logger.error("Failed to publish System default graph", e)
                call.respond(HttpStatusCode.InternalServerError, ErrorResponse(error = "Internal server error"))
            }
        }

        put(Routes.ADMIN_DEFAULT_GRAPH, { hidden = true }) {
            try {
                val customerId = call.requireAdminCustomerId(customerProfileService, appConfig)
                val req = call.receive<UpdateAgentRequest>()
                try {
                    logger.info("Admin {} updating the System default graph", customerId)
                    call.respond(graphService.updateSystemDefaultGraph(req))
                } catch (e: IllegalArgumentException) {
                    call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "${e.message}"))
                } catch (e: IllegalStateException) {
                    // Thrown by the service only: no System graph published yet.
                    call.respond(HttpStatusCode.NotFound, ErrorResponse(error = "${e.message}"))
                }
            } catch (e: SerializationException) {
                call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "Invalid request format"))
            } catch (e: IllegalStateException) {
                // requireAdminCustomerId already responded (403)
            } catch (e: Exception) {
                logger.error("Failed to update System default graph", e)
                call.respond(HttpStatusCode.InternalServerError, ErrorResponse(error = "Internal server error"))
            }
        }
    }
}
