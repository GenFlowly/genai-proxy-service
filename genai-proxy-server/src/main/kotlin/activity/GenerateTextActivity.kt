package com.genflowly.activity

import com.genflowly.Routes
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.post
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.SerializationException
import models.GenerateTextRequest
import models.GenerateTextResponse
import models.Message
import org.slf4j.LoggerFactory
import service.AIRequestManager

private val logger = LoggerFactory.getLogger("GenerateTextRoute")

fun Route.registerGenerateTextRoutes(
    aiRequestManager: AIRequestManager
) {
    authenticate("auth0") {
        post(Routes.GENERATE_TEXT) {
            try {
                val request = call.receive<GenerateTextRequest>()

                // Validate aiVendors list
                if (request.aiVendors.isEmpty()) {
                    logger.warn("Received GenerateText request with no AI vendors")
                    call.respond(
                        HttpStatusCode.BadRequest,
                        mapOf("error" to "At least one AI vendor must be provided")
                    )
                    return@post
                }

                logger.info(
                    "Received GenerateText request: vendors={}, model={}, promptLength={}, vendorCount={}",
                    request.aiVendors.joinToString(",") { it.name },
                    request.model,
                    request.prompt.length,
                    request.aiVendors.size
                )

                val conversationId = aiRequestManager.getConversationId(request)

                val message = Message(
                    conversationId = conversationId,
                    customerId = request.customerId,
                    client = request.client,
                    role = "user",
                    text = request.prompt,
                    previousMessageId = request.selectedResponseId
                )

                val results = coroutineScope {
                    request.aiVendors.map { aiVendor ->
                        async {
                            val startTime = System.currentTimeMillis()
                            try {


                                val response = aiRequestManager.handleRequest(
                                    aiVendor = aiVendor,
                                    model = request.model,
                                    message = message
                                )

                                val durationMs = System.currentTimeMillis() - startTime

                                logger.info(
                                    "AI response received: vendor={}, model={}, durationMs={}",
                                    aiVendor,
                                    request.model,
                                    durationMs
                                )

                                response

                            } catch (e: Exception) {
                                logger.error(
                                    "Error generating text: vendor={}, model={}, message={}",
                                    aiVendor,
                                    request.model,
                                    e.message,
                                    e
                                )
                                GenerateTextResponse(
                                    text = "[Error: ${e.message}]",
                                    messageId = null,
                                    conversationId = null,
                                    aiVendor = null
                                )
                            }
                        }
                    }.awaitAll()
                }

                // Return single response if only one vendor, otherwise return list
                if (results.size == 1) {
                    call.respond(results.first())
                } else {
                    call.respond(
                        mapOf(
                            "responses" to results,
                            "count" to results.size
                        )
                    )
                }

            } catch (e: SerializationException) {
                logger.error("Malformed GenerateText request: {}", e.message, e)
                call.respond(
                    HttpStatusCode.BadRequest,
                    mapOf("error" to "Invalid request format: ${e.message}")
                )
            } catch (e: Exception) {
                logger.error("Unexpected error in GenerateText controller: {}", e.message, e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    mapOf("error" to "Internal server error: ${e.message}")
                )
            }
        }
    }
}
