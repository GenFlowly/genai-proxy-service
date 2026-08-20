package com.genflowly.activity.instruction

import com.genflowly.Routes
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.InstructionResponse
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory
import com.genflowly.service.AIRequestManager

private val logger = LoggerFactory.getLogger("GetInstructionVersionRoute")

fun Route.registerGetInstructionVersionRoutes(
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0", "apiKey") {
        get("${Routes.GET_CUSTOMER_INSTRUCTION_VERSION}/{instructionId}/{version}", {
            tags("Instructions")
            summary = "Get a specific version of an instruction"
            request {
                pathParameter<String>("instructionId") {
                    description = "Instruction to fetch"
                }
                pathParameter<Int>("version") {
                    description = "Version number to fetch"
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "The requested instruction version"
                    body<InstructionResponse>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "Missing or invalid instructionId/version"
                    body<String>()
                }
                code(HttpStatusCode.NotFound) {
                    description = "Instruction version not found"
                    body<String>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                    body<ErrorResponse>()
                }
            }
        }) {
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