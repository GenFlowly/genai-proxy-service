package com.genflowly.activity.instruction

import com.genflowly.Routes
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import org.slf4j.LoggerFactory
import service.AIRequestManager

private val logger = LoggerFactory.getLogger("GetInstructionVersionRoute")

fun Route.registerGetInstructionVersionRoutes(
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0") {
        get("${Routes.GET_CUSTOMER_INSTRUCTION_VERSION}/{instructionId}/{version}") {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)

                val instructionId = call.parameters["instructionId"]
                val versionStr = call.parameters["version"]
                val version = versionStr?.toIntOrNull()

                if (instructionId == null || version == null) {
                    call.respond(HttpStatusCode.BadRequest, "Missing or invalid instructionId/version")
                    return@get
                }

                val response = customerProfileService.getInstructionVersion(customerId, instructionId, version)
                
                if (response != null) {
                    call.respond(response)
                } else {
                    call.respond(HttpStatusCode.NotFound, "Instruction version not found")
                }
            } catch (e: Exception) {
                logger.error(
                    "Unexpected error in Get Instruction Version controller: {}",
                    e.message,
                    e
                )
                call.respond(
                    HttpStatusCode.InternalServerError,
                    mapOf("error" to "Internal server error: ${e.message}")
                )
            }
        }
    }
}