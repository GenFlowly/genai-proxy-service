package com.genflowly.activity.conversation

import com.genflowly.Routes
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.GetConversationMetaResponse
import com.genflowly.service.ConversationAccessDeniedException
import com.genflowly.service.ConversationService
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.getAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("GetConversationMetaRoute")

fun Route.registerGetConversationMetaRoutes(
    customerProfileService: CustomerProfileService,
    conversationService: ConversationService
) {
    authenticate("auth0", "apiKey", optional = true) {
        get(Routes.GET_CONVERSATION_META, {
            tags("Conversations")
            summary = "Get conversation metadata (title)"
            description = "Returns just the conversation title, without messages. Authentication is " +
                    "optional: unauthenticated callers can only access publicly shared conversations. " +
                    "Used by the edge router to inject link-preview titles into /chat pages."
            request {
                queryParameter<String>("conversationId") {
                    description = "Conversation whose metadata to fetch"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Conversation metadata"
                    body<GetConversationMetaResponse>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "Missing conversationId"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.Forbidden) {
                    description = "Caller does not have access to this conversation"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                    body<ErrorResponse>()
                }
            }
        }) {
            try {
                val conversationId = call.request.queryParameters["conversationId"]
                if (conversationId.isNullOrBlank()) {
                    call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Missing conversationId"))
                    return@get
                }

                val customerId = call.getAuthenticatedCustomerId(customerProfileService) ?: "PUBLIC"

                val title = conversationService.getConversationTitle(conversationId, customerId)
                call.respond(GetConversationMetaResponse(title = title))
            } catch (e: ConversationAccessDeniedException) {
                call.respond(HttpStatusCode.Forbidden, mapOf("error" to "Access denied"))
            } catch (e: Exception) {
                logger.error("Unexpected error in Get Conversation Meta controller: {}", e.message, e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    mapOf("error" to "Internal server error: ${e.message}")
                )
            }
        }
    }
}
