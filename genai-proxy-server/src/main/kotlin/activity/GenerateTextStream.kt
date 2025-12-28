package com.genflowly.activity

import com.genflowly.Routes
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.response.respondTextWriter
import io.ktor.server.routing.Route
import io.ktor.server.routing.post
import kotlinx.serialization.SerializationException
import models.GenerateTextRequest
import org.slf4j.LoggerFactory
import service.AIRequestManager

private val logger = LoggerFactory.getLogger("GenerateTextStreamRoute")

fun Route.registerGenerateTextStreamRoutes(
    aiRequestManager: AIRequestManager,
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0") {
        post(Routes.GENERATE_TEXT_STREAM) {
            try {
                val request = call.receive<GenerateTextRequest>()

                val customerId = call.requireAuthenticatedCustomerId(
                    customerProfileService
                )

                if (request.aiConfig.isEmpty()) {
                    call.respond(
                        HttpStatusCode.BadRequest,
                        mapOf("error" to "At least one AI vendor must be provided")
                    )
                    return@post
                }

                logger.info(
                    "Received GenerateTextStream request from customerId {} : {}",
                    customerId,
                    request.toString()
                )

                call.respondTextWriter(contentType = ContentType.Text.Plain) {
                    try {
                        aiRequestManager.processTextGenerateStreamRequest(
                            request.aiConfig,
                            request.prompt.systemPrompt,
                            request.prompt.prompt,
                            request.conversationId,
                            request.selectedResponseId,
                            request.client,
                            customerId
                        ).collect { chunk ->
                            write(chunk)
                            flush()
                        }
                    } catch (e: Exception) {
                        logger.error("Error during streaming response", e)
                        // If headers are already sent, we can't change status code.
                        // We might want to close the connection or write an error marker if protocol allows.
                        // For plain text, we just stop.
                    }
                }

            } catch (e: SerializationException) {
                logger.error("Malformed GenerateTextStream request: {}", e.message, e)
                call.respond(
                    HttpStatusCode.BadRequest,
                    mapOf("error" to "Invalid request format: ${e.message}")
                )
            } catch (e: Exception) {
                logger.error(
                    "Unexpected error in GenerateTextStream controller: {}",
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
