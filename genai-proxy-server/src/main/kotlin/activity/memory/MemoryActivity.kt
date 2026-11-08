package com.genflowly.activity.memory

import com.genflowly.DynamoDBConstants
import com.genflowly.Routes
import com.genflowly.models.api.CopyMemoryRequest
import com.genflowly.models.api.CreateMemoryRequest
import com.genflowly.models.api.DeleteAllMemoriesResponse
import com.genflowly.models.api.DeleteMemoryResponse
import com.genflowly.models.api.EditMemoryRequest
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.GetMemoriesResponse
import com.genflowly.models.api.LearnedFactView
import com.genflowly.models.api.LearnedFactsResponse
import com.genflowly.models.api.MemoryDetailResponse
import com.genflowly.models.api.MemoryResponse
import com.genflowly.models.api.MemoryUsagePage
import com.genflowly.models.api.MoveMemoryRequest
import com.genflowly.service.ConversationService
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.MemoryConflictException
import com.genflowly.service.MemoryNotFoundException
import com.genflowly.service.MemoryRequestException
import com.genflowly.service.MemoryService
import com.genflowly.utils.ensureAiDataConsent
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.config.RequestConfig
import io.github.smiley4.ktoropenapi.config.ResponsesConfig
import io.github.smiley4.ktoropenapi.delete
import io.github.smiley4.ktoropenapi.get
import io.github.smiley4.ktoropenapi.post
import io.github.smiley4.ktoropenapi.put
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.call
import io.ktor.server.auth.authenticate
import io.ktor.server.plugins.BadRequestException
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("MemoryActivity")

private const val WEB_APP_ONLY = "Web-app only: requires an Auth0 JWT; not accessible with a developer API key."

/**
 * Memory routes. Ids look like "MEM#<uuid>", so clients must URL-encode
 * them in the path. Only memory rows are reachable here: any other id is
 * reported as not found.
 */
fun Route.registerMemoryRoutes(
    memoryService: MemoryService,
    customerProfileService: CustomerProfileService,
    conversationService: ConversationService
) {
    authenticate("auth0") {
        get(Routes.GET_LEARNED_FACTS, {
            tags("Memories")
            summary = "Facts learned from one exchange"
            description = "Async memory-extraction outcome for an assistant message. " +
                    "status=pending until extraction writes its marker; then status=done " +
                    "with the facts (possibly empty — nothing was learned)."
            request {
                queryParameter<String>("conversationId") {
                    description = "Conversation"
                    required = true
                }
                queryParameter<String>("messageId") {
                    description = "Assistant message of the exchange"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) { body<LearnedFactsResponse>() }
                code(HttpStatusCode.NotFound) { body<ErrorResponse>() }
            }
        }) {
            val conversationId = call.request.queryParameters["conversationId"]
            val messageId = call.request.queryParameters["messageId"]
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
                    call.respond(LearnedFactsResponse(status = "pending"))
                } else {
                    val facts = runCatching {
                        Json { ignoreUnknownKeys = true }.decodeFromString<List<LearnedFactView>>(factsJson)
                    }.getOrDefault(emptyList())
                    call.respond(LearnedFactsResponse(status = "done", facts = facts))
                }
            } catch (e: Exception) {
                logger.error("Error fetching learned facts for $messageId", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to "Failed to fetch learned facts"))
            }
        }

        get(Routes.GET_MEMORIES, {
            tags("Memories")
            summary = "List what the assistant has learned about the customer"
            description = "Every memory, newest first, with where it applies (Profile or projects, " +
                    "each with its kind), its version and how often it was used. $WEB_APP_ONLY"
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
            call.handleMemoryErrors("list memories") {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                call.respond(HttpStatusCode.OK, memoryService.getMemories(customerId))
            }
        }

        post(Routes.GET_MEMORIES, {
            tags("Memories")
            summary = "Add a memory"
            description = "A memory the customer writes, saved as version 1. Without projectId it " +
                    "applies in Profile (every conversation); with one, only in that project. $WEB_APP_ONLY"
            request {
                body<CreateMemoryRequest> {
                    description = "Text (1-${MemoryService.MAX_TEXT_CHARS} characters), kind and optional project"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "The new memory"
                    body<MemoryResponse>()
                }
                badRequest("Blank or too-long text, or an unknown project")
            }
        }) {
            call.handleMemoryErrors("add a memory") {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                if (!call.ensureAiDataConsent(customerProfileService)) return@handleMemoryErrors
                val request = call.receive<CreateMemoryRequest>()
                call.respond(HttpStatusCode.OK, MemoryResponse(memoryService.createMemory(customerId, request)))
            }
        }

        delete(Routes.GET_MEMORIES, {
            tags("Memories")
            summary = "Forget all memories"
            description = "Hard-deletes every memory the assistant learned about the customer, " +
                    "with their change and usage logs and their embeddings. $WEB_APP_ONLY"
            response {
                code(HttpStatusCode.OK) {
                    description = "Memories deleted"
                    body<DeleteAllMemoriesResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                    body<ErrorResponse>()
                }
            }
        }) {
            call.handleMemoryErrors("delete memories") {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val deleted = memoryService.deleteAllMemories(customerId)
                call.respond(HttpStatusCode.OK, DeleteAllMemoriesResponse(status = "success", deleted = deleted))
            }
        }

        get(Routes.MEMORY, {
            tags("Memories")
            summary = "One memory with its versions and change log"
            description = "Versions and change-log entries are newest first. Each change says what " +
                    "caused it; the source conversation's title and the customer's own words are " +
                    "read live, so they are absent once that conversation is deleted. $WEB_APP_ONLY"
            request { memoryIdParameter() }
            response {
                code(HttpStatusCode.OK) {
                    description = "The memory"
                    body<MemoryDetailResponse>()
                }
                notFound()
            }
        }) {
            call.handleMemoryErrors("read a memory") {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                call.respond(HttpStatusCode.OK, memoryService.getMemoryDetail(customerId, call.memoryId()))
            }
        }

        put(Routes.MEMORY, {
            tags("Memories")
            summary = "Edit a memory"
            description = "Saves the text as a new version. Earlier versions are never changed. " +
                    "Refused with 409 when a version newer than baseVersion exists. $WEB_APP_ONLY"
            request {
                memoryIdParameter()
                body<EditMemoryRequest> { required = true }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "The memory at its new version"
                    body<MemoryResponse>()
                }
                badRequest("Blank or too-long text")
                notFound()
                conflict()
            }
        }) {
            call.handleMemoryErrors("edit a memory") {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                if (!call.ensureAiDataConsent(customerProfileService)) return@handleMemoryErrors
                val request = call.receive<EditMemoryRequest>()
                call.respond(HttpStatusCode.OK, MemoryResponse(memoryService.editMemory(customerId, call.memoryId(), request)))
            }
        }

        delete(Routes.MEMORY, {
            tags("Memories")
            summary = "Forget a memory"
            description = "Without projectId, or when the memory applies only there, hard-deletes it " +
                    "everywhere with its change and usage logs and embeddings (deleted=true). With " +
                    "projectId on a memory shared by several projects, removes it from that project " +
                    "only (deleted=false). $WEB_APP_ONLY"
            request {
                memoryIdParameter()
                queryParameter<String>("projectId") {
                    description = "Project to remove the memory from"
                    required = false
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Memory deleted, or removed from the project"
                    body<DeleteMemoryResponse>()
                }
                badRequest("The memory doesn't apply in that project")
                notFound()
                conflict()
            }
        }) {
            call.handleMemoryErrors("delete a memory") {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val projectId = call.request.queryParameters["projectId"]?.takeIf { it.isNotBlank() }
                val deleted = memoryService.deleteMemory(customerId, call.memoryId(), projectId)
                call.respond(HttpStatusCode.OK, DeleteMemoryResponse(status = "success", deleted = deleted))
            }
        }

        post(Routes.MOVE_MEMORY, {
            tags("Memories")
            summary = "Move a memory"
            description = "Changes where the memory applies: Profile Core and Episodic, Profile and a " +
                    "project, or one project and another (null project ids mean Profile). Moving to " +
                    "Profile drops every project it was in. Versions and change log are kept. $WEB_APP_ONLY"
            request {
                memoryIdParameter()
                body<MoveMemoryRequest> { required = true }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "The memory where it now applies"
                    body<MemoryResponse>()
                }
                badRequest("It doesn't apply at the source, already applies at the target, or the project is unknown")
                notFound()
                conflict()
            }
        }) {
            call.handleMemoryErrors("move a memory") {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val request = call.receive<MoveMemoryRequest>()
                call.respond(HttpStatusCode.OK, MemoryResponse(memoryService.moveMemory(customerId, call.memoryId(), request)))
            }
        }

        post(Routes.COPY_MEMORY, {
            tags("Memories")
            summary = "Copy a project memory to another project"
            description = "Adds another project to a project memory. Both projects share the same " +
                    "memory: text, versions, change log and hit counter. Profile memories can't be " +
                    "copied, since they already apply everywhere. $WEB_APP_ONLY"
            request {
                memoryIdParameter()
                body<CopyMemoryRequest> { required = true }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "The memory with the added project"
                    body<MemoryResponse>()
                }
                badRequest("A Profile memory, not in the source project, already in the target, or an unknown project")
                notFound()
                conflict()
            }
        }) {
            call.handleMemoryErrors("copy a memory") {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val request = call.receive<CopyMemoryRequest>()
                call.respond(HttpStatusCode.OK, MemoryResponse(memoryService.copyMemory(customerId, call.memoryId(), request)))
            }
        }

        get(Routes.MEMORY_USAGE, {
            tags("Memories")
            summary = "Replies a memory was used in"
            description = "One page of the usage log, newest first: each reply the memory was sent " +
                    "to the model for. total is the memory's hit counter. $WEB_APP_ONLY"
            request {
                memoryIdParameter()
                queryParameter<Int>("limit") {
                    description = "Page size, 1-${MemoryService.MAX_USAGE_PAGE} (default 25)"
                    required = false
                }
                queryParameter<String>("cursor") {
                    description = "nextCursor from the previous page"
                    required = false
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "One page of the usage log"
                    body<MemoryUsagePage>()
                }
                notFound()
            }
        }) {
            call.handleMemoryErrors("read a memory's usage") {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val limit = call.request.queryParameters["limit"]?.toIntOrNull() ?: DEFAULT_USAGE_PAGE
                val cursor = call.request.queryParameters["cursor"]?.takeIf { it.isNotBlank() }
                call.respond(HttpStatusCode.OK, memoryService.getUsagePage(customerId, call.memoryId(), limit, cursor))
            }
        }
    }
}

private const val DEFAULT_USAGE_PAGE = 25

private fun ApplicationCall.memoryId(): String {
    val id = parameters["memoryId"]
    if (id.isNullOrBlank() || !id.startsWith(DynamoDBConstants.MEMORY_ITEM_PREFIX)) {
        throw MemoryNotFoundException(id ?: "")
    }
    return id
}

private suspend fun ApplicationCall.handleMemoryErrors(action: String, block: suspend () -> Unit) {
    try {
        block()
    } catch (e: MemoryNotFoundException) {
        respond(HttpStatusCode.NotFound, mapOf("error" to "Memory not found"))
    } catch (e: MemoryConflictException) {
        respond(HttpStatusCode.Conflict, mapOf("error" to (e.message ?: "The memory changed; reload it")))
    } catch (e: MemoryRequestException) {
        respond(HttpStatusCode.BadRequest, mapOf("error" to (e.message ?: "Invalid request")))
    } catch (e: BadRequestException) {
        respond(HttpStatusCode.BadRequest, mapOf("error" to "Invalid request body"))
    } catch (e: SerializationException) {
        respond(HttpStatusCode.BadRequest, mapOf("error" to "Invalid request body"))
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        logger.error("Error trying to $action", e)
        respond(HttpStatusCode.InternalServerError, mapOf("error" to "Failed to $action"))
    }
}

private fun RequestConfig.memoryIdParameter() {
    pathParameter<String>("memoryId") {
        description = "Memory id (\"MEM#…\", URL-encoded)"
    }
}

private fun ResponsesConfig.badRequest(why: String) {
    code(HttpStatusCode.BadRequest) {
        description = why
        body<ErrorResponse>()
    }
}

private fun ResponsesConfig.notFound() {
    code(HttpStatusCode.NotFound) {
        description = "Memory does not exist"
        body<ErrorResponse>()
    }
}

private fun ResponsesConfig.conflict() {
    code(HttpStatusCode.Conflict) {
        description = "The memory changed since it was read; reload and try again"
        body<ErrorResponse>()
    }
}
