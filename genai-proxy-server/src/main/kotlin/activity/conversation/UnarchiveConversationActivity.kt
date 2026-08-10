package com.genflowly.activity

import com.genflowly.Routes
import com.genflowly.service.ConversationService
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.post
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("UnarchiveConversationRoute")

fun Route.registerUnarchiveConversationRoutes(
    customerProfileService: CustomerProfileService,
    conversationService: ConversationService
) {
    authenticate("auth0") {
        post(Routes.UNARCHIVE_CONVERSATION) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val conversationId = call.parameters["conversationId"]

                if (conversationId.isNullOrBlank()) {
                    return@post call.respond(
                        HttpStatusCode.BadRequest,
                        mapOf("error" to "Missing conversationId")
                    )
                }

                conversationService.unarchiveConversation(
                    conversationId = conversationId,
                    customerId = customerId
                )

                call.respond(HttpStatusCode.OK, mapOf("status" to "success"))
            } catch (e: SecurityException) {
                logger.warn("Unauthorized conversation unarchive attempt: {}", e.message)
                call.respond(HttpStatusCode.Forbidden, mapOf("error" to (e.message ?: "Forbidden")))
            } catch (e: Exception) {
                logger.error("Unexpected error in Unarchive Conversation controller: {}", e.message, e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    mapOf("error" to "Internal server error: ${e.message}")
                )
            }
        }
    }
}
