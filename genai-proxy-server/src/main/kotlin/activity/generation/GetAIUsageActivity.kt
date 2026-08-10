package com.genflowly.activity

import com.genflowly.Routes
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import org.slf4j.LoggerFactory
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.ConversationService
import com.genflowly.utils.requireAuthenticatedCustomerId

private val logger = LoggerFactory.getLogger("GetAIUsageActivity")

fun Route.registerGetAIUsageActivityRoutes(
    conversationService: ConversationService,
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0") {
        get(Routes.GET_AI_USAGE) {
            try {
                val conversationId = call.request.queryParameters["conversationId"]
                val messageId = call.request.queryParameters["messageId"]

                if (conversationId.isNullOrBlank() || messageId.isNullOrBlank()) {
                    call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Missing conversationId or messageId"))
                    return@get
                }

                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)

                val usage = conversationService.getMessageUsage(conversationId, messageId)
                if (usage != null) {
                    call.respond(usage)
                } else {
                    call.respond(HttpStatusCode.NotFound, mapOf("error" to "Message not found or usage not available"))
                }

            } catch (e: Exception) {
                logger.error(
                    "Unexpected error in Get AI Usage Activity controller: {}",
                    e.message,
                    e
                )
                call.respond(
                    HttpStatusCode.InternalServerError,
                    mapOf("error" to "Internal server error: ${e.message}")
                )
            }
        }
    }
}
