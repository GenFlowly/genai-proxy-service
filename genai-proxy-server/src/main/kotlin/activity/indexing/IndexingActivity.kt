package com.genflowly.activity.indexing

import com.genflowly.Routes
import com.genflowly.models.api.DeleteIndexedChatsResponse
import com.genflowly.models.api.ErrorResponse
import com.genflowly.service.ConversationIndexingService
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.delete
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("IndexingActivity")

/** Settings > Defaults > Search index. Requires an Auth0 JWT. */
fun Route.registerIndexingRoutes(
    conversationIndexingService: ConversationIndexingService,
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0") {
        delete(Routes.INDEXED_CHATS, {
            tags("Indexing")
            summary = "Delete indexed chats"
            description = "Removes every chat the customer's vector DB holds for search, and the chats still " +
                "waiting to be indexed. Whether new chats are indexed is the indexChats preference. " +
                "Web-app only: requires an Auth0 JWT."
            response {
                code(HttpStatusCode.OK) {
                    description = "Indexed chats deleted"
                    body<DeleteIndexedChatsResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "The vector DB could not be cleared"
                    body<ErrorResponse>()
                }
            }
        }) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val deleted = conversationIndexingService.deleteIndexedChats(customerId)
                call.respond(HttpStatusCode.OK, DeleteIndexedChatsResponse(status = "success", deleted = deleted))
            } catch (e: Exception) {
                logger.error("Error deleting indexed chats", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to "Failed to delete indexed chats"))
            }
        }
    }
}
