package com.genflowly.activity

import com.genflowly.Routes
import com.genflowly.models.api.SearchCustomerResponse
import com.genflowly.service.ConversationService
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("GetConversationSharedUsersActivity")

fun Route.registerGetConversationSharedUsersRoutes(
    customerProfileService: CustomerProfileService,
    conversationService: ConversationService
) {
    authenticate("auth0") {
        get(Routes.GET_CONVERSATION_SHARED_USERS) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val conversationId = call.parameters["conversationId"]
                    ?: return@get call.respond(
                        HttpStatusCode.BadRequest,
                        mapOf("error" to "Missing conversationId")
                    )

                val profiles = conversationService.getSharedUsersForConversation(conversationId, customerId)

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
