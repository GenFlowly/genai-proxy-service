package com.genflowly.activity.agent

import com.genflowly.Routes
import com.genflowly.models.api.AgentResponse
import com.genflowly.models.api.ErrorResponse
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.GraphService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("GetAgentActivity")

fun Route.registerGetAgentRoutes(
    graphService: GraphService,
    customerProfileService: CustomerProfileService,
) {
    authenticate("auth0", "apiKey") {
        get(Routes.GET_AGENT, {
            tags("Agents")
            summary = "Get a single agent"
            description = "Returns one agent (hydrated graph + nodes). Resolves the customer's own " +
                    "graphs and, as a read-only fallback, the System-published default graph " +
                    "(isSystem=true in the response)."
            request {
                pathParameter<String>("graphId") { description = "Agent graph to fetch" }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "The agent (hydrated graph + nodes)"
                    body<AgentResponse>()
                }
                code(HttpStatusCode.NotFound) {
                    description = "graphId not found or not visible to this customer"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                    body<ErrorResponse>()
                }
            }
        }) {
            val graphId = call.parameters["graphId"] ?: return@get call.respond(
                HttpStatusCode.BadRequest, mapOf("error" to "Missing graphId")
            )
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                call.respond(graphService.getAgent(customerId, graphId))
            } catch (e: IllegalStateException) {
                logger.warn("Agent not found for graphId=$graphId: ${e.message}")
                call.respond(HttpStatusCode.NotFound, mapOf("error" to e.message))
            } catch (e: Exception) {
                logger.error("Failed to get agent graphId=$graphId", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to e.message))
            }
        }
    }
}
