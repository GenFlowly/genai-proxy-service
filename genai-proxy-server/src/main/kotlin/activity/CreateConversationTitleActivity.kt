package com.genflowly.activity

import com.genflowly.Routes
import com.genflowly.models.api.CreateConversationTitleRequest
import com.genflowly.models.api.CreateConversationTitleResponse
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.post
import kotlinx.serialization.SerializationException
import org.slf4j.LoggerFactory
import service.AIRequestManager

private val logger = LoggerFactory.getLogger("CreateConversationTitleRoute")

fun Route.registerCreateConversationTitleRoutes(
    aiRequestManager: AIRequestManager,
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0") {
        post(Routes.CREATE_CONVERSATION_TITLE) {
            try {
                val request = call.receive<CreateConversationTitleRequest>()
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)

                logger.info(
                    "Received CreateConversationTitle request from customerId {}: {}",
                    customerId,
                    request
                )

                val title = aiRequestManager.createConversationTitle(
                    request.conversationId,
                    customerId,
                    request.prompt,
                    request.instructionName
                )

                call.respond(
                    HttpStatusCode.OK,
                    CreateConversationTitleResponse(title = title)
                )

            } catch (e: SerializationException) {
                logger.error("Malformed CreateConversationTitle request: {}", e.message, e)
                call.respond(
                    HttpStatusCode.BadRequest,
                    mapOf("error" to "Invalid request format: ${e.message}")
                )
            } catch (e: Exception) {
                logger.error(
                    "Unexpected error in CreateConversationTitle controller: {}",
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
