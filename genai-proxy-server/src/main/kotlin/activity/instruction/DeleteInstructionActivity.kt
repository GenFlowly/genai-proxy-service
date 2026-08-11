package com.genflowly.activity.instruction

import com.genflowly.Routes
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.delete
import org.slf4j.LoggerFactory
import com.genflowly.service.CustomerProfileService

private val logger = LoggerFactory.getLogger("DeleteInstructionRoute")

fun Route.registerDeleteInstructionRoutes(
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0") {
        delete(Routes.DELETE_INSTRUCTION) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val instructionId = call.parameters["instructionId"]
                
                if (instructionId == null) {
                    call.respond(HttpStatusCode.BadRequest, mapOf("error" to "instructionId path parameter is required"))
                    return@delete
                }

                customerProfileService.deleteInstruction(customerId, instructionId)

                call.respond(HttpStatusCode.OK, mapOf("status" to "success"))

            } catch (e: SecurityException) {
                logger.warn("Unauthorized delete attempt: {}", e.message)
                call.respond(HttpStatusCode.Forbidden, mapOf("error" to "You do not have permission to delete this instruction"))
            } catch (e: Exception) {
                logger.error("Unexpected error in Delete Instruction controller: {}", e.message, e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    mapOf("error" to "Internal server error: ${e.message}")
                )
            }
        }
    }
}
