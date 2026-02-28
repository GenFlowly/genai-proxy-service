package com.genflowly.activity

import com.genflowly.Routes
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.response.respondTextWriter
import io.ktor.server.routing.Route
import io.ktor.server.routing.post
import kotlinx.serialization.SerializationException
import com.genflowly.models.api.GenerateTextStreamRequest
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
                val request = call.receive<GenerateTextStreamRequest>()

                val customerId = call.requireAuthenticatedCustomerId(
                    customerProfileService
                )

                val conversationId = aiRequestManager.getConversationId(
                    customerId,
                    request.client,
                    request.conversationId
                )

                
                logger.info(
                    "Received GenerateTextStream request from customerId {} : {}",
                    customerId,
                    request.toString()
                )

                call.response.header("Cache-Control", "no-cache")
                call.response.header("Connection", "keep-alive")
                call.response.header("X-Accel-Buffering", "no")

                val streamResult = aiRequestManager.processTextGenerateStreamRequest(
                    listOf(request.aiConfig),
                    request.prompt.instructionId,
                    request.prompt.instructionVersion,
                    request.prompt.prompt,
                    conversationId,
                    request.selectedResponseId,
                    request.client,
                    customerId
                )

                // Send Metadata Headers
                // conversationId is already set (or resolved), but let's sync with result
                call.response.header("X-Conversation-Id", streamResult.conversationId)
                call.response.header("X-Message-Id", streamResult.messageId) // User Msg ID
                call.response.header("X-Response-Message-Id", streamResult.responseMessageId) // Assistant Msg ID
                call.response.header("X-Ai-Vendor", request.aiConfig.aiVendor.toString())

                call.respondTextWriter(contentType = ContentType.Text.Plain) {
                    try {
                        // Force flush headers and send a heartbeat byte (space) immediately 
                        // to prevent client timeout (TTFB) while waiting for AI vendor
                        write(" ")
                        flush()
                        
                        streamResult.flow.collect { chunk ->
                            write(chunk)
                            flush()
                        }
                    } catch (e: java.io.IOException) {
                        logger.warn("Stream closed by client: {}", e.message)
                    } catch (e: Exception) {
                        logger.error("Error during streaming response", e)
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
