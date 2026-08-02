package com.genflowly.activity

import com.genflowly.Routes
import com.genflowly.models.api.CreateInstructionShareRequest
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.post
import io.ktor.server.routing.delete
import org.slf4j.LoggerFactory
import com.genflowly.service.CustomerProfileService

private val logger = LoggerFactory.getLogger("CreateInstructionShareRoute")

fun Route.registerCreateInstructionShareRoutes(
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0") {
        post(Routes.CREATE_INSTRUCTION_SHARE) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val request = call.receive<CreateInstructionShareRequest>()

                customerProfileService.shareInstruction(
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
        
        delete(Routes.CREATE_INSTRUCTION_SHARE) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val instructionId = call.request.queryParameters["instructionId"]
                val targetCustomerId = call.request.queryParameters["targetCustomerId"]

                if (instructionId == null || targetCustomerId == null) {
                    return@delete call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Missing instructionId or targetCustomerId"))
                }

                customerProfileService.unshareInstruction(
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
