package com.genflowly.activity.agent

import com.genflowly.Routes
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.GraphService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("GetCustomerAgentsActivity")

fun Route.registerGetCustomerAgentsRoutes(
    graphService: GraphService,
    customerProfileService: CustomerProfileService,
) {
    authenticate("auth0") {
        get(Routes.GET_CUSTOMER_AGENTS) {
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
