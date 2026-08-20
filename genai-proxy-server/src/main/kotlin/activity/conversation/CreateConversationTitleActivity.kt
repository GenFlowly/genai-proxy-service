package com.genflowly.activity.conversation

import com.genflowly.Routes
import com.genflowly.models.api.CreateConversationTitleRequest
import com.genflowly.models.api.CreateConversationTitleResponse
import com.genflowly.models.api.ErrorResponse
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.SerializationException
import org.slf4j.LoggerFactory
import com.genflowly.service.ConversationService

private val logger = LoggerFactory.getLogger("CreateConversationTitleRoute")

fun Route.registerCreateConversationTitleRoutes(
    conversationService: ConversationService,
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0", "apiKey") {
        post(Routes.CREATE_CONVERSATION_TITLE, {
            tags("Conversations")
            summary = "Generate a conversation title"
            description = "Uses AI to generate and store a short title for the conversation based " +
                    "on the prompt and instruction name."
            request {
                body<CreateConversationTitleRequest> {
                    description = "Conversation, prompt and instruction context"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Generated title"
                    body<CreateConversationTitleResponse>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "Malformed request body"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                    body<ErrorResponse>()
                }
            }
        }) {
            try {
                val request = call.receive<CreateConversationTitleRequest>()
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)

                logger.info(
                    "Received CreateConversationTitle request from customerId {}: {}",
                    customerId,
                    request
                )

                val title = conversationService.createConversationTitle(
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
