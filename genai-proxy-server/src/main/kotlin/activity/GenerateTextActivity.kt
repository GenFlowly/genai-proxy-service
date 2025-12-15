package com.genflowly.activity

import com.genflowly.Routes
import com.genflowly.utils.requireAuthenticatedCustomerId
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
import models.BatchGenerateTextResponse
import models.GenerateTextRequest
import models.GenerateTextResponse
import models.Message
import org.slf4j.LoggerFactory
import service.AIRequestManager
import service.CustomerProfileService

private val logger = LoggerFactory.getLogger("GenerateTextRoute")

fun Route.registerGenerateTextRoutes(
    aiRequestManager: AIRequestManager,
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0") {
        post(Routes.GENERATE_TEXT) {
            try {
                val request = call.receive<GenerateTextRequest>()

                // Extract customerId from JWT token
                val customerId = call.requireAuthenticatedCustomerId(
                    customerProfileService
                )

                val client = request.client

                // Validate aiVendors list
                if (request.aiConfig.isEmpty()) {
                    logger.warn(
                        "Received GenerateText request with no AI " +
                                "config"
                    )
                    call.respond(
                        HttpStatusCode.BadRequest,
                        mapOf("error" to "At least one AI vendor must be provided")
                    )
                    return@post
                }

                logger.info(
                    "Received GenerateText request from customerId {} : {}",
                    customerId,
                    request.toString()
                )

                val conversationId =
                    aiRequestManager.getConversationId(request, customerId, client)

                logger.info("Retrieved conversationId: {}", conversationId)

                val message = Message(
                    conversationId = conversationId,
                    customerId = customerId,
                    client = client,
                    role = "user",
                    text = request.prompt,
                    previousMessageId = request.selectedResponseId
                )

                val results = coroutineScope {
                    request.aiConfig.map { aiConfig ->
                        async {
                            val startTime = System.currentTimeMillis()
                            try {
                                val response = aiRequestManager.handleRequest(
                                    aiVendor = aiConfig.aiVendor,
                                    model = aiConfig.model,
                                    message = message
                                )
                                val durationMs =
                                    System.currentTimeMillis() - startTime

                                logger.info(
                                    "AI response received: vendor={}, model={}, durationMs={}",
                                    aiConfig.aiVendor,
                                    aiConfig.model,
                                    durationMs
                                )

                                response

                            } catch (e: Exception) {
                                logger.error(
                                    "Error generating text: vendor={}, model={}, message={}",
                                    aiConfig.aiVendor,
                                    aiConfig.model,
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

                if (results.size == 1) {
                    call.respond(results.first())
                } else {
                    call.respond(
                        BatchGenerateTextResponse(
                            results = results
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
                logger.error(
                    "Unexpected error in GenerateText controller: {}",
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
