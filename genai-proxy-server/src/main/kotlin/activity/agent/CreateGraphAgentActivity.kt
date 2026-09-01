package com.genflowly.activity.agent

import com.genflowly.Routes
import com.genflowly.models.api.AgentResponse
import com.genflowly.models.api.CreateGraphAgentRequest
import com.genflowly.models.api.ErrorResponse
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.GraphService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("CreateGraphAgentActivity")

fun Route.registerCreateGraphAgentRoutes(
    graphService: GraphService,
    customerProfileService: CustomerProfileService,
) {
    authenticate("auth0", "apiKey") {
        /**
         * POST /api/v1/agents/graph
         *
         * Creates a multi-node agent graph authored in the visual editor.
         * Node references in entryPoint/edges/layout use client tempIds; the
         * server generates real nodeIds and substitutes them before validating.
         */
        post(Routes.CREATE_GRAPH_AGENT, {
            tags("Agents")
            summary = "Create a multi-node agent graph"
            description = "Creates an agent graph from the visual editor. Nodes are identified by " +
                    "client tempIds referenced from entryPoint/edges/layout; the server generates " +
                    "real nodeIds and validates the full structure before writing."
            request {
                body<CreateGraphAgentRequest> {
                    description = "The graph to create"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "The created agent (hydrated graph + nodes)"
                    body<AgentResponse>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "Structural validation failure"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                    body<ErrorResponse>()
                }
            }
        }) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val req = call.receive<CreateGraphAgentRequest>()
                call.respond(graphService.createGraphAgent(customerId, req))
            } catch (e: IllegalArgumentException) {
                logger.warn("Graph agent creation validation failed: ${e.message}")
                call.respond(HttpStatusCode.BadRequest, mapOf("error" to e.message))
            } catch (e: Exception) {
                logger.error("Failed to create graph agent", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to e.message))
            }
        }
    }
}
