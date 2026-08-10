package com.genflowly.activity.instruction

import com.genflowly.Routes
import com.genflowly.utils.getAuthenticatedCustomerId
import com.genflowly.service.CustomerProfileService
import io.ktor.server.application.*
import io.ktor.server.auth.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.http.HttpStatusCode
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("GetCustomerInstructionListRoute")

fun Route.registerGetCustomerInstructionListRoutes(
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0", optional = true) {
        get(Routes.GET_CUSTOMER_INSTRUCTIONS) {
            try {
                val customerId = call.getAuthenticatedCustomerId(customerProfileService) ?: "PUBLIC"

                val response = customerProfileService.getCustomerInstructions(customerId)
                call.respond(response)

            } catch (e: Exception) {
                logger.error("Error fetching customer instructions", e)
                call.respond(HttpStatusCode.InternalServerError, "Failed to fetch instructions")
            }
        }
    }
}