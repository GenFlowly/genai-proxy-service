package com.genflowly.activity.instruction

import com.genflowly.Routes
import com.genflowly.activity.search.respondSearchFailure
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.GetCustomerInstructionListResponse
import com.genflowly.models.api.SearchErrorResponse
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
    authenticate("auth0", "apiKey") {
        get(Routes.SEARCH_INSTRUCTIONS, {
            tags("Instructions")
            summary = "Search instructions"
            description = "Semantic search over the latest version of every instruction the " +
                    "caller can access, owned and shared alike (visibility is enforced by an " +
                    "accessible-ids filter at query time; each instruction is indexed once, " +
                    "under its creator). Instruction text, name, category and tags are " +
                    "embedded; results are ordered by similarity. A blank query returns all " +
                    "latest instructions. Requires sign-in."
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
                code(HttpStatusCode.Unauthorized) {
                    description = "Not signed in"
                }
                code(HttpStatusCode.Forbidden) {
                    description = "No customer profile for the signed-in user"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.Conflict) {
                    description = "Search isn't set up for this customer (code SEARCH_NOT_CONFIGURED); " +
                            "'reason' names the missing setting: VECTOR_DB_NOT_CONFIGURED or EMBEDDING_KEY_MISSING"
                    body<SearchErrorResponse>()
                }
                code(HttpStatusCode.BadGateway) {
                    description = "The search backend failed (code SEARCH_UNAVAILABLE)"
                    body<SearchErrorResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                    body<String>()
                }
            }
        }) {
            try {
                val customerId = call.getAuthenticatedCustomerId(customerProfileService)
                if (customerId == null) {
                    call.respond(HttpStatusCode.Forbidden, mapOf("error" to "Customer profile not found"))
                    return@get
                }
                val query = call.request.queryParameters["q"] ?: ""

                val response = instructionService.searchInstructions(customerId, query)
                call.respond(response)
            } catch (e: Exception) {
                if (call.respondSearchFailure(e)) return@get
                logger.error("Error searching instructions", e)
                call.respond(HttpStatusCode.InternalServerError, "Failed to search instructions")
            }
        }
    }
}
