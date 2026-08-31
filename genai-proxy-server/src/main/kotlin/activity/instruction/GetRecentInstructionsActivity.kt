package com.genflowly.activity.instruction

import com.genflowly.Routes
import com.genflowly.models.api.GetCustomerInstructionListResponse
import com.genflowly.utils.getAuthenticatedCustomerId
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.InstructionService
import io.github.smiley4.ktoropenapi.get
import io.ktor.server.application.*
import io.ktor.server.auth.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.http.HttpStatusCode
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("GetRecentInstructionsRoute")

private const val DEFAULT_LIMIT = 3
private const val MAX_LIMIT = 20

fun Route.registerGetRecentInstructionsRoutes(
    instructionService: InstructionService,
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0", "apiKey", optional = true) {
        get(Routes.GET_RECENT_INSTRUCTIONS, {
            tags("Instructions")
            summary = "Recently used instructions"
            description = "The latest versions of the caller's most-recently-used instructions, " +
                    "ordered by recency. Instructions the caller can no longer access are omitted."
            request {
                queryParameter<Int>("limit") {
                    description = "Maximum number of instructions to return (default $DEFAULT_LIMIT, max $MAX_LIMIT)"
                    required = false
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Recently used instructions, most recent first"
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
                val limit = (call.request.queryParameters["limit"]?.toIntOrNull() ?: DEFAULT_LIMIT)
                    .coerceIn(1, MAX_LIMIT)

                val response = instructionService.getRecentlyUsedInstructions(customerId, limit)
                call.respond(response)
            } catch (e: Exception) {
                logger.error("Error fetching recent instructions", e)
                call.respond(HttpStatusCode.InternalServerError, "Failed to fetch recent instructions")
            }
        }
    }
}
