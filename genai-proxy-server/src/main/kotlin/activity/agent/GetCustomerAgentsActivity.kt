package com.genflowly.activity.agent

import com.genflowly.Routes
import com.genflowly.models.api.ErrorResponse
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.GraphService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import models.api.GetCustomerAgentsResponse
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("GetCustomerAgentsActivity")

fun Route.registerGetCustomerAgentsRoutes(
    graphService: GraphService,
    customerProfileService: CustomerProfileService,
) {
    authenticate("auth0", "apiKey") {
        get(Routes.GET_CUSTOMER_AGENTS, {
            tags("Agents")
            summary = "List the customer's agents"
            description = "Returns all agent graphs (with their nodes) owned by the customer."
            response {
                code(HttpStatusCode.OK) {
                    description = "The customer's agents"
                    body<GetCustomerAgentsResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                    body<ErrorResponse>()
                }
            }
        }) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val response = graphService.getCustomerAgents(customerId)
                call.respond(response)
            } catch (e: Exception) {
                logger.error("Failed to get customer agents", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to e.message))
            }
        }
    }
}
