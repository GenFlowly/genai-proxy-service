package com.genflowly.activity.instruction

import com.genflowly.Routes
import com.genflowly.models.api.GetCustomerInstructionListResponse
import com.genflowly.utils.getAuthenticatedCustomerId
import com.genflowly.service.CustomerProfileService
import io.github.smiley4.ktoropenapi.get
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
        get(Routes.GET_CUSTOMER_INSTRUCTIONS, {
            tags("Instructions")
            summary = "List instructions"
            description = "Returns the customer's instructions (own and shared). Authentication is " +
                    "optional: unauthenticated callers receive the public instruction set."
            response {
                code(HttpStatusCode.OK) {
                    description = "Instructions available to the caller"
                    body<GetCustomerInstructionListResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                    body<String>()
                }
            }
        }) {
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