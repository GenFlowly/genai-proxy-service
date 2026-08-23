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

private val logger = LoggerFactory.getLogger("SearchInstructionsRoute")

fun Route.registerSearchInstructionsRoutes(
    instructionService: InstructionService,
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0", "apiKey", optional = true) {
        get(Routes.SEARCH_INSTRUCTIONS, {
            tags("Instructions")
            summary = "Search instructions"
            description = "Case-insensitive search over the latest version of every instruction " +
                    "the caller can access, matching name, category, tags or instruction text. " +
                    "A blank query returns all latest instructions. Authentication is optional: " +
                    "unauthenticated callers search the public instruction set."
            request {
                queryParameter<String>("q") {
                    description = "Search query; blank returns all latest instructions"
                    required = false
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Instructions matching the query"
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
                val query = call.request.queryParameters["q"] ?: ""

                val response = instructionService.searchInstructions(customerId, query)
                call.respond(response)
            } catch (e: Exception) {
                logger.error("Error searching instructions", e)
                call.respond(HttpStatusCode.InternalServerError, "Failed to search instructions")
            }
        }
    }
}
