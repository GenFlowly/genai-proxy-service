package com.genflowly.activity.instruction

import com.genflowly.Routes
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.InstructionUsageResponse
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.InstructionNotFoundException
import com.genflowly.service.InstructionUsageService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("GetInstructionUsageActivity")

fun Route.registerGetInstructionUsageRoutes(
    instructionUsageService: InstructionUsageService,
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0") {
        get(Routes.INSTRUCTION_USAGE, {
            tags("Instructions")
            summary = "How the caller has used an instruction"
            description = "In how many conversations the caller used it, when last, and which conversations. " +
                    "Usage is the caller's own: an owner never sees the conversations of the people it is shared with."
            request {
                pathParameter<String>("instructionId") {
                    description = "Instruction to inspect"
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "The caller's usage"
                    body<InstructionUsageResponse>()
                }
                code(HttpStatusCode.NotFound) {
                    description = "No such instruction, or the caller can't see it"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                    body<ErrorResponse>()
                }
            }
        }) {
            val instructionId = call.parameters["instructionId"].orEmpty()
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                call.respond(instructionUsageService.getUsage(customerId, instructionId))
            } catch (e: InstructionNotFoundException) {
                call.respond(HttpStatusCode.NotFound, mapOf("error" to "Instruction not found"))
            } catch (e: Exception) {
                logger.error("Failed to read usage of instruction {}", instructionId, e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to "Failed to read instruction usage"))
            }
        }
    }
}
