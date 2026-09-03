package com.genflowly.activity.memory

import com.genflowly.Routes
import com.genflowly.models.api.DeleteMemoryResponse
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.GetMemoriesResponse
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.MemoryNotFoundException
import com.genflowly.service.MemoryService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.delete
import io.github.smiley4.ktoropenapi.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("MemoryActivity")

fun Route.registerMemoryRoutes(
    memoryService: MemoryService,
    customerProfileService: CustomerProfileService,
    conversationService: com.genflowly.service.ConversationService
) {
    authenticate("auth0") {
        get(Routes.GET_LEARNED_FACTS, {
            tags("Memories")
            summary = "Facts learned from one exchange"
            description = "Async memory-extraction outcome for an assistant message. " +
                    "status=pending until extraction writes its marker; then status=done " +
                    "with the facts (possibly empty — nothing was learned)."
            request {
                pathParameter<String>("conversationId") { description = "Conversation" }
                pathParameter<String>("messageId") { description = "Assistant message of the exchange" }
            }
            response {
                code(HttpStatusCode.OK) { body<com.genflowly.models.api.LearnedFactsResponse>() }
                code(HttpStatusCode.NotFound) { body<ErrorResponse>() }
            }
        }) {
            val conversationId = call.parameters["conversationId"]
            val messageId = call.parameters["messageId"]
            if (conversationId.isNullOrBlank() || messageId.isNullOrBlank()) {
                return@get call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Missing ids"))
            }
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val message = conversationService.getMessage(conversationId, messageId)
                if (message == null || message.customerId != customerId) {
                    return@get call.respond(HttpStatusCode.NotFound, mapOf("error" to "Message not found"))
                }
                val factsJson = message.learnedFactsJson
                if (factsJson == null) {
                    call.respond(com.genflowly.models.api.LearnedFactsResponse(status = "pending"))
                } else {
                    val facts = runCatching {
                        kotlinx.serialization.json.Json { ignoreUnknownKeys = true }
                            .decodeFromString<List<com.genflowly.models.api.LearnedFactView>>(factsJson)
                    }.getOrDefault(emptyList())
                    call.respond(com.genflowly.models.api.LearnedFactsResponse(status = "done", facts = facts))
                }
            } catch (e: Exception) {
                logger.error("Error fetching learned facts for $messageId", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to "Failed to fetch learned facts"))
            }
        }

        get(Routes.GET_MEMORIES, {
            tags("Memories")
            summary = "List what the assistant has learned about the customer"
            description = "Long-term memories extracted from the customer's conversations and notes. " +
                    "Web-app only: requires an Auth0 JWT; not accessible with a developer API key."
            response {
                code(HttpStatusCode.OK) {
                    description = "The customer's memories"
                    body<GetMemoriesResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                    body<ErrorResponse>()
                }
            }
        }) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                call.respond(HttpStatusCode.OK, memoryService.getMemories(customerId))
            } catch (e: Exception) {
                logger.error("Error fetching memories", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to "Failed to fetch memories"))
            }
        }

        delete(Routes.DELETE_MEMORY, {
            tags("Memories")
            summary = "Forget a memory"
            description = "Hard-deletes the memory and its embeddings. " +
                    "Web-app only: requires an Auth0 JWT; not accessible with a developer API key."
            request {
                pathParameter<String>("memoryId") {
                    description = "Memory to forget"
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Memory deleted"
                    body<DeleteMemoryResponse>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "Missing memoryId"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.NotFound) {
                    description = "Memory does not exist"
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
                val memoryId = call.parameters["memoryId"]
                if (memoryId.isNullOrBlank()) {
                    return@delete call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Missing memoryId"))
                }
                memoryService.deleteMemory(customerId, memoryId)
                call.respond(HttpStatusCode.OK, DeleteMemoryResponse(status = "success"))
            } catch (e: MemoryNotFoundException) {
                call.respond(HttpStatusCode.NotFound, mapOf("error" to "Memory not found"))
            } catch (e: Exception) {
                logger.error("Error deleting memory", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to "Failed to delete memory"))
            }
        }
    }
}
