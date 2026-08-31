package com.genflowly.activity.instruction

import com.genflowly.Routes
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.StatusResponse
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.delete
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.InstructionService

private val logger = LoggerFactory.getLogger("DeleteInstructionRoute")

fun Route.registerDeleteInstructionRoutes(
    instructionService: InstructionService,
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0", "apiKey") {
        delete(Routes.DELETE_INSTRUCTION, {
            tags("Instructions")
            summary = "Delete an instruction"
            request {
                pathParameter<String>("instructionId") {
                    description = "Instruction to delete"
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Instruction deleted"
                    body<StatusResponse>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "Missing instructionId"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.Forbidden) {
                    description = "Caller does not have permission to delete this instruction"
                    body<ErrorResponse>()
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
                
                if (instructionId == null) {
                    call.respond(HttpStatusCode.BadRequest, mapOf("error" to "instructionId path parameter is required"))
                    return@delete
                }

                instructionService.deleteInstruction(customerId, instructionId)

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
