package com.genflowly.activity.conversation

import com.genflowly.Routes
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.GetCustomerConversationsResponse
import com.genflowly.service.ConversationManagementService
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("GetCustomerConversationsPaginatedRoute")

fun Route.registerGetCustomerConversationsPaginatedRoutes(
    customerProfileService: CustomerProfileService,
    conversationManagementService: ConversationManagementService
) {
    authenticate("auth0", "apiKey") {
        get(Routes.GET_CUSTOMER_CONVERSATIONS_PAGINATED, {
            tags("Conversations")
            summary = "List conversations (paginated)"
            description = "Returns the customer's conversations, newest first, with cursor-based pagination."
            request {
                queryParameter<Int>("pageSize") {
                    description = "Page size, 1-50 (default 10)"
                    required = false
                }
                queryParameter<String>("lastEvaluatedKey") {
                    description = "Pagination cursor returned by the previous page"
                    required = false
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "One page of conversations plus the cursor for the next page"
                    body<GetCustomerConversationsResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                    body<ErrorResponse>()
                }
            }
        }) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)

                val pageSizeParam = call.request.queryParameters["pageSize"]?.toIntOrNull() ?: 10
                val pageSize = pageSizeParam.coerceIn(1, 50) // cap at 50 for safety

                val exclusiveStartKey = call.request.queryParameters["lastEvaluatedKey"]?.takeIf { it.isNotBlank() }

                logger.info(
                    "GetCustomerConversationsPaginated: customerId={}, pageSize={}, hasStartKey={}",
                    customerId, pageSize, exclusiveStartKey != null
                )

                val response = conversationManagementService.getCustomerConversationsPaginated(
                    customerId = customerId,
                    pageSize = pageSize,
                    exclusiveStartKey = exclusiveStartKey
                )

                call.respond(HttpStatusCode.OK, response)

            } catch (e: Exception) {
                logger.error(
                    "Unexpected error in GetCustomerConversationsPaginated controller: {}",
                    e.message, e
                )
                call.respond(
                    HttpStatusCode.InternalServerError,
                    mapOf("error" to "Internal server error: ${e.message}")
                )
            }
        }
    }
}
