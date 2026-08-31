package com.genflowly.activity.agent

import com.genflowly.Routes
import com.genflowly.models.api.ErrorResponse
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.GraphService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.delete
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("DeleteAgentActivity")

fun Route.registerDeleteAgentRoutes(
    graphService: GraphService,
    customerProfileService: CustomerProfileService,
) {
    authenticate("auth0", "apiKey") {
        delete(Routes.DELETE_AGENT, {
            tags("Agents")
            summary = "Delete an agent"
            description = "Deletes an agent (graph) and its nodes. The default graph cannot be deleted."
            request {
                pathParameter<String>("graphId") {
                    description = "Agent graph to delete"
                }
            }
            response {
                code(HttpStatusCode.NoContent) { description = "Agent deleted" }
                code(HttpStatusCode.BadRequest) {
                    description = "The default graph cannot be deleted"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.NotFound) {
                    description = "graphId not found or not owned by this customer"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                    body<ErrorResponse>()
                }
            }
        }) {
            val graphId = call.parameters["graphId"] ?: return@delete call.respond(
                HttpStatusCode.BadRequest, ErrorResponse(error = "Missing graphId")
            )
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                try {
                    graphService.deleteAgent(customerId, graphId)
                } catch (e: IllegalStateException) {
                    return@delete call.respond(
                        HttpStatusCode.NotFound,
                        ErrorResponse(error = e.message ?: "Agent not found")
                    )
                } catch (e: IllegalArgumentException) {
                    return@delete call.respond(
                        HttpStatusCode.BadRequest,
                        ErrorResponse(error = e.message ?: "Invalid request")
                    )
                }
                call.respond(HttpStatusCode.NoContent)
            } catch (e: Exception) {
                logger.error("Unexpected error deleting agent {}: {}", graphId, e.message, e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ErrorResponse(error = "Internal server error")
                )
            }
        }
    }
}
