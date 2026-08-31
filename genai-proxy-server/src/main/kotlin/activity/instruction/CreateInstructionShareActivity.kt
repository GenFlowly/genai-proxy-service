package com.genflowly.activity.instruction

import com.genflowly.Routes
import com.genflowly.models.api.CreateInstructionShareRequest
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.StatusResponse
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.delete
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.InstructionService

private val logger = LoggerFactory.getLogger("CreateInstructionShareRoute")

fun Route.registerCreateInstructionShareRoutes(
    instructionService: InstructionService,
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0", "apiKey") {
        post(Routes.CREATE_INSTRUCTION_SHARE, {
            tags("Instructions")
            summary = "Share an instruction with another user"
            request {
                body<CreateInstructionShareRequest> {
                    description = "Instruction, target customer and role"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Instruction shared"
                    body<StatusResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                    body<ErrorResponse>()
                }
            }
        }) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val request = call.receive<CreateInstructionShareRequest>()

                instructionService.shareInstruction(
                    instructionId = request.instructionId,
                    targetCustomerId = request.targetCustomerId,
                    sharedByCustomerId = customerId,
                    role = request.role
                )

                call.respond(HttpStatusCode.OK, mapOf("status" to "success"))

            } catch (e: Exception) {
                logger.error("Unexpected error in Create Instruction Share controller: {}", e.message, e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    mapOf("error" to "Internal server error: ${e.message}")
                )
            }
        }
        
        delete(Routes.CREATE_INSTRUCTION_SHARE, {
            tags("Instructions")
            summary = "Revoke an instruction share"
            request {
                queryParameter<String>("instructionId") {
                    description = "Instruction to unshare"
                    required = true
                }
                queryParameter<String>("targetCustomerId") {
                    description = "Customer whose access is revoked"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Share revoked"
                    body<StatusResponse>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "Missing instructionId or targetCustomerId"
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
                val instructionId = call.request.queryParameters["instructionId"]
                val targetCustomerId = call.request.queryParameters["targetCustomerId"]

                if (instructionId == null || targetCustomerId == null) {
                    return@delete call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Missing instructionId or targetCustomerId"))
                }

                instructionService.unshareInstruction(
                    instructionId = instructionId,
                    targetCustomerId = targetCustomerId,
                    sharedByCustomerId = customerId
                )

                call.respond(HttpStatusCode.OK, mapOf("status" to "success"))

            } catch (e: Exception) {
                logger.error("Unexpected error in Delete Instruction Share controller: {}", e.message, e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    mapOf("error" to "Internal server error: ${e.message}")
                )
            }
        }
    }
}
