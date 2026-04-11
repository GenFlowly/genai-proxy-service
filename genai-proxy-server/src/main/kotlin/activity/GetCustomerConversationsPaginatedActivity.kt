package com.genflowly.activity

import com.genflowly.Routes
import com.genflowly.service.ConversationService
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("GetCustomerConversationsPaginatedRoute")

fun Route.registerGetCustomerConversationsPaginatedRoutes(
    customerProfileService: CustomerProfileService,
    conversationService: ConversationService
) {
    authenticate("auth0") {
        get(Routes.GET_CUSTOMER_CONVERSATIONS_PAGINATED) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)

                val pageSizeParam = call.request.queryParameters["pageSize"]?.toIntOrNull() ?: 10
                val pageSize = pageSizeParam.coerceIn(1, 50) // cap at 50 for safety

                val exclusiveStartKey = call.request.queryParameters["lastEvaluatedKey"]?.takeIf { it.isNotBlank() }

                logger.info(
                    "GetCustomerConversationsPaginated: customerId={}, pageSize={}, hasStartKey={}",
                    customerId, pageSize, exclusiveStartKey != null
                )

                val response = conversationService.getCustomerConversationsPaginated(
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
