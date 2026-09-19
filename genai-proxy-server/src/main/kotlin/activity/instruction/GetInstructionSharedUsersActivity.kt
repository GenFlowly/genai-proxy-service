package com.genflowly.activity.instruction

import com.genflowly.Routes
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.SearchCustomerResponse
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.InstructionService

private val logger = LoggerFactory.getLogger("GetInstructionSharedUsersActivity")

fun Route.registerGetInstructionSharedUsersRoutes(
    instructionService: InstructionService,
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0", "apiKey") {
        get(Routes.GET_INSTRUCTION_SHARED_USERS, {
            tags("Instructions")
            summary = "List users an instruction is shared with"
            request {
                queryParameter<String>("instructionId") {
                    description = "Instruction to inspect"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Users the instruction is shared with"
                    body<List<SearchCustomerResponse>>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "Missing instructionId"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.Forbidden) {
                    description = "Caller does not own this instruction"
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
                    ?: return@get call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Missing instructionId"))

                val profiles = instructionService.getSharedUsersForInstruction(customerId, instructionId)
                
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
