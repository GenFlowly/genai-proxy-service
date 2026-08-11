package com.genflowly.activity.agent

import com.genflowly.Routes
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.GraphService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.put
import models.api.UpdateAgentRequest
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("UpdateAgentActivity")

fun Route.registerUpdateAgentRoutes(
    graphService: GraphService,
    customerProfileService: CustomerProfileService,
) {
    authenticate("auth0") {
        /**
         * PUT /api/v1/agents/{graphId}
         *
         * Edits an agent (graph + nodes) in place with full LangGraph structural validation.
         *
         * Editable graph fields : name, isDefault, maxIterations, entryPoint, edges
         * Editable per-node fields: name, config  (nodeType is NOT editable here)
         * nodeIds are immutable via this endpoint — use the graph-node CRUD APIs.
         *
         * Responses:
         *   200  — updated AgentResponse (hydrated graph + nodes)
         *   400  — structural validation failure (descriptive error message)
         *   404  — graphId not found or not owned by this customer
         *   500  — unexpected server error
         */
        put(Routes.UPDATE_AGENT) {
            val graphId = call.parameters["graphId"] ?: return@put call.respond(
                HttpStatusCode.BadRequest, mapOf("error" to "Missing graphId")
            )
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val req = call.receive<UpdateAgentRequest>()
                val response = graphService.updateAgent(customerId, graphId, req)
                call.respond(response)
            } catch (e: IllegalArgumentException) {
                // Structural validation failure or node-not-in-graph error
                logger.warn("Agent update validation failed for graphId=$graphId: ${e.message}")
                call.respond(HttpStatusCode.BadRequest, mapOf("error" to e.message))
            } catch (e: IllegalStateException) {
                // Graph not found or ownership check failed
                logger.warn("Agent update not found for graphId=$graphId: ${e.message}")
                call.respond(HttpStatusCode.NotFound, mapOf("error" to e.message))
            } catch (e: Exception) {
                logger.error("Failed to update agent graphId=$graphId", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to e.message))
            }
        }
    }
}
