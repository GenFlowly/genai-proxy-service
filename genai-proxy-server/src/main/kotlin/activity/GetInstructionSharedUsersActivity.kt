package com.genflowly.activity

import com.genflowly.Routes
import com.genflowly.models.api.SearchCustomerResponse
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import org.slf4j.LoggerFactory
import com.genflowly.service.CustomerProfileService

private val logger = LoggerFactory.getLogger("GetInstructionSharedUsersActivity")

fun Route.registerGetInstructionSharedUsersRoutes(
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0") {
        get(Routes.GET_INSTRUCTION_SHARED_USERS) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val instructionId = call.parameters["instructionId"]
                    ?: return@get call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Missing instructionId"))

                val profiles = customerProfileService.getSharedUsersForInstruction(customerId, instructionId)
                
                val responseList = profiles.map {
                    SearchCustomerResponse(
                        customerId = it.customerId,
                        name = it.name,
                        username = it.username ?: "",
                        picture = it.picture,
                        role = it.role
                    )
                }

                call.respond(HttpStatusCode.OK, responseList)

            } catch (e: SecurityException) {
                logger.warn("Unauthorized access to instruction share list: {}", e.message)
                call.respond(
                    HttpStatusCode.Forbidden,
                    mapOf("error" to (e.message ?: "Forbidden"))
                )
            } catch (e: Exception) {
                logger.error("Unexpected error in Get Instruction Shared Users controller: {}", e.message, e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    mapOf("error" to "Internal server error: ${e.message}")
                )
            }
        }
    }
}
