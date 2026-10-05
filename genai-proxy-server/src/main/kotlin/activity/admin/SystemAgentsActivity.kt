package com.genflowly.activity.admin

import com.genflowly.Routes
import com.genflowly.config.AppConfig
import com.genflowly.models.api.CreateGraphAgentRequest
import com.genflowly.models.api.ErrorResponse
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.GraphService
import com.genflowly.utils.requireAdminCustomerId
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.SerializationException
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("SystemAgentsActivity")

/**
 * Admin publishing of NON-default System-owned agents — shared templates
 * (e.g. the agent-loop template) that every customer sees read-only in their
 * agent picker and forks on first edit. Distinct from /admin/default-graph,
 * which manages the ONE graph served to customers without a graph of their
 * own: publishing here never changes behavior for anyone who doesn't select
 * the new agent. Listing/editing/deleting go through the regular /agents
 * endpoints, which already handle System ownership for admin callers.
 * JWT-only, allowlist-gated and hidden from the public OpenAPI spec, same
 * posture as the default-graph endpoints.
 */
fun Route.registerSystemAgentsRoutes(
    graphService: GraphService,
    customerProfileService: CustomerProfileService,
    appConfig: AppConfig,
) {
    authenticate("auth0") {
        post(Routes.ADMIN_SYSTEM_AGENTS, { hidden = true }) {
            try {
                val customerId = call.requireAdminCustomerId(customerProfileService, appConfig)
                val req = call.receive<CreateGraphAgentRequest>()
                try {
                    logger.info("Admin {} publishing System agent '{}'", customerId, req.name)
                    call.respond(HttpStatusCode.Created, graphService.publishSystemAgent(req))
                } catch (e: IllegalArgumentException) {
                    call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "${e.message}"))
                }
            } catch (e: SerializationException) {
                call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "Invalid request format"))
            } catch (e: IllegalStateException) {
                // requireAdminCustomerId already responded (403)
            } catch (e: Exception) {
                logger.error("Failed to publish System agent", e)
                call.respond(HttpStatusCode.InternalServerError, ErrorResponse(error = "Internal server error"))
            }
        }
    }
}
