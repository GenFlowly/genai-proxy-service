package com.genflowly.activity.conversation

import com.genflowly.Routes
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.SearchCustomerResponse
import com.genflowly.service.ConversationManagementService
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("GetConversationSharedUsersActivity")

fun Route.registerGetConversationSharedUsersRoutes(
    customerProfileService: CustomerProfileService,
    conversationManagementService: ConversationManagementService
) {
    authenticate("auth0", "apiKey") {
        get(Routes.GET_CONVERSATION_SHARED_USERS, {
            tags("Conversations")
            summary = "List users a conversation is shared with"
            request {
                pathParameter<String>("conversationId") {
                    description = "Conversation to inspect"
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Users the conversation is shared with"
                    body<List<SearchCustomerResponse>>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "Missing conversationId"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.Forbidden) {
                    description = "Caller does not own this conversation"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                    body<ErrorResponse>()
                }
            }
        }) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val conversationId = call.parameters["conversationId"]
                    ?: return@get call.respond(
                        HttpStatusCode.BadRequest,
                        mapOf("error" to "Missing conversationId")
                    )

                val profiles = conversationManagementService.getSharedUsersForConversation(conversationId, customerId)

                val responseList = profiles.map {
                    SearchCustomerResponse(
                        customerId = it.customerId,
                        name = it.name,
                        username = it.username ?: "",
                        picture = it.picture,
                        role = it.role
                    )
                }

                call.respond(HttpStatusCode.OK, responseList)
            } catch (e: SecurityException) {
                logger.warn("Unauthorized access to conversation share list: {}", e.message)
                call.respond(HttpStatusCode.Forbidden, mapOf("error" to (e.message ?: "Forbidden")))
            } catch (e: Exception) {
                logger.error("Unexpected error in Get Conversation Shared Users controller: {}", e.message, e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    mapOf("error" to "Internal server error: ${e.message}")
                )
            }
        }
    }
}
