package com.genflowly.activity.conversation

import com.genflowly.Routes
import com.genflowly.models.api.CreateConversationShareRequest
import com.genflowly.service.ConversationService
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.delete
import io.ktor.server.routing.post
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("CreateConversationShareRoute")

fun Route.registerCreateConversationShareRoutes(
    customerProfileService: CustomerProfileService,
    conversationService: ConversationService
) {
    authenticate("auth0") {
        post(Routes.CREATE_CONVERSATION_SHARE) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val request = call.receive<CreateConversationShareRequest>()

                conversationService.shareConversation(
                    conversationId = request.conversationId,
                    targetCustomerId = request.targetCustomerId,
                    sharedByCustomerId = customerId,
                    role = request.role
                )

                call.respond(HttpStatusCode.OK, mapOf("status" to "success"))
            } catch (e: SecurityException) {
                logger.warn("Unauthorized conversation share attempt: {}", e.message)
                call.respond(HttpStatusCode.Forbidden, mapOf("error" to (e.message ?: "Forbidden")))
            } catch (e: com.genflowly.service.ConversationArchivedException) {
                logger.warn("Attempted to share archived conversation: {}", e.message)
                call.respond(HttpStatusCode.BadRequest, mapOf("error" to (e.message ?: "Cannot share archived conversation")))
            } catch (e: Exception) {
                logger.error("Unexpected error in Create Conversation Share controller: {}", e.message, e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    mapOf("error" to "Internal server error: ${e.message}")
                )
            }
        }

        delete(Routes.CREATE_CONVERSATION_SHARE) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val conversationId = call.request.queryParameters["conversationId"]
                val targetCustomerId = call.request.queryParameters["targetCustomerId"]

                if (conversationId == null || targetCustomerId == null) {
                    return@delete call.respond(
                        HttpStatusCode.BadRequest,
                        mapOf("error" to "Missing conversationId or targetCustomerId")
                    )
                }

                conversationService.unshareConversation(
                    conversationId = conversationId,
                    targetCustomerId = targetCustomerId,
                    sharedByCustomerId = customerId
                )

                call.respond(HttpStatusCode.OK, mapOf("status" to "success"))
            } catch (e: SecurityException) {
                logger.warn("Unauthorized conversation unshare attempt: {}", e.message)
                call.respond(HttpStatusCode.Forbidden, mapOf("error" to (e.message ?: "Forbidden")))
            } catch (e: Exception) {
                logger.error("Unexpected error in Delete Conversation Share controller: {}", e.message, e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    mapOf("error" to "Internal server error: ${e.message}")
                )
            }
        }
    }
}
