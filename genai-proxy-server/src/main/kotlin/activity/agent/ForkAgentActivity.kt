package com.genflowly.activity.agent

import com.genflowly.Routes
import com.genflowly.models.api.AgentResponse
import com.genflowly.models.api.ErrorResponse
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.GraphService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("ForkAgentActivity")

fun Route.registerForkAgentRoutes(
    graphService: GraphService,
    customerProfileService: CustomerProfileService,
) {
    authenticate("auth0", "apiKey") {
        /**
         * POST /api/v1/agents/{graphId}/fork
         *
         * Forks a System (shared) agent into a customer-owned editable copy
         * named `<agent-name>-<version>-forked` (version = the source's
         * latest at fork time). The fork inherits the source's category; for
         * request-type agents the customer's map override is mirrored onto
         * the fork; a fork of the System default graph becomes the
         * customer's default. Only System agents are forkable.
         *
         * Responses:
         *   201  — the fork (hydrated AgentResponse, isSystem=false)
         *   404  — graphId not found or not a System agent
         *   500  — unexpected server error
         */
        post(Routes.FORK_AGENT, {
            tags("Agents")
            summary = "Fork a System agent"
            description = "Clones a shared System agent into a customer-owned editable copy named " +
                    "<agent-name>-<version>-forked. System agents are read-only — this is the only " +
                    "way to derive an editable copy."
            request {
                pathParameter<String>("graphId") {
                    description = "System agent graph to fork"
                }
            }
            response {
                code(HttpStatusCode.Created) {
                    description = "The customer-owned fork (hydrated graph + nodes)"
                    body<AgentResponse>()
                }
                code(HttpStatusCode.NotFound) {
                    description = "graphId not found or not a System agent"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                    body<ErrorResponse>()
                }
            }
        }) {
            val graphId = call.parameters["graphId"] ?: return@post call.respond(
                HttpStatusCode.BadRequest, mapOf("error" to "Missing graphId")
            )
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val response = graphService.forkAgent(customerId, graphId)
                call.respond(HttpStatusCode.Created, response)
            } catch (e: IllegalStateException) {
                logger.warn("Agent fork not found for graphId=$graphId: ${e.message}")
                call.respond(HttpStatusCode.NotFound, mapOf("error" to e.message))
            } catch (e: Exception) {
                logger.error("Failed to fork agent graphId=$graphId", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to e.message))
            }
        }
    }
}
