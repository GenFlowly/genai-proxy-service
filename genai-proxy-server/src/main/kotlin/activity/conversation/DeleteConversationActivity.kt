package com.genflowly.activity.conversation

import com.genflowly.Routes
import com.genflowly.service.ConversationService
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.delete
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("DeleteConversationRoute")

fun Route.registerDeleteConversationRoutes(
    customerProfileService: CustomerProfileService,
    conversationService: ConversationService
) {
    authenticate("auth0") {
        delete(Routes.DELETE_CONVERSATION) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val conversationId = call.parameters["conversationId"]

                if (conversationId.isNullOrBlank()) {
                    return@delete call.respond(
                        HttpStatusCode.BadRequest,
                        mapOf("error" to "Missing conversationId")
                    )
                }

                conversationService.archiveConversation(
                    conversationId = conversationId,
                    customerId = customerId
                )

                call.respond(HttpStatusCode.OK, mapOf("status" to "success"))
            } catch (e: SecurityException) {
                logger.warn("Unauthorized conversation archive attempt: {}", e.message)
                call.respond(HttpStatusCode.Forbidden, mapOf("error" to (e.message ?: "Forbidden")))
            } catch (e: Exception) {
                logger.error("Unexpected error in Delete Conversation controller: {}", e.message, e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    mapOf("error" to "Internal server error: ${e.message}")
                )
            }
        }
    }
}
