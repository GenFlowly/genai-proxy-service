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

private val logger = LoggerFactory.getLogger("GetConversationRoute")



fun Route.registerGetConversationRoutes(
    customerProfileService: CustomerProfileService,
    conversationService: ConversationService
) {
    authenticate("auth0") {
        get("${Routes.GET_CONVERSATION}/{conversationId}") {
            try {
                val conversationId = call.parameters["conversationId"]

                // TODO think about it
                if (conversationId.isNullOrBlank()) {
                    call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Missing conversationId"))
                    return@get
                }

                val response = conversationService.getConversationHistory(conversationId)
                call.respond(response)

            } catch (e: Exception) {
                logger.error(
                    "Unexpected error in Get Conversation controller: {}",
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