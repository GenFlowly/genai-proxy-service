package com.genflowly.activity.generation

import com.genflowly.Routes
import com.genflowly.models.api.ErrorResponse
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.SerializationException
import models.BatchGenerateTextResponse
import models.GenerateTextRequest
import models.GenerateTextResponse
import models.Message
import org.slf4j.LoggerFactory
import service.AIRequestManager
import com.genflowly.service.CustomerProfileService

private val logger = LoggerFactory.getLogger("GenerateTextRoute")

fun Route.registerGenerateTextRoutes(
    aiRequestManager: AIRequestManager,
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0") {
        post(Routes.GENERATE_TEXT, {
            tags("Generation")
            summary = "Generate AI text responses"
            description = "Sends a prompt to one or more configured AI vendors and returns the " +
                    "generated responses. Creates a new conversation when conversationId is null, " +
                    "otherwise appends to the existing conversation."
            request {
                body<GenerateTextRequest> {
                    description = "Prompt, AI vendor configuration and conversation context"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "One generated result per requested AI configuration"
                    body<BatchGenerateTextResponse>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "Malformed request body or empty aiConfig list"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.Forbidden) {
                    description = "Authenticated user has no customer profile (not onboarded)"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                    body<ErrorResponse>()
                }
            }
        }) {
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


                val responseMessageList = aiRequestManager
                    .processTextGenerateRequest(
                        request.aiConfig,
                        request.prompt.instructionId,
                        request.prompt.instructionVersion,
                        request.prompt.prompt,
                        request.conversationId,
                        request.selectedResponseId,
                        request.client,
                        customerId
                    )

                val generateTextResponseList =
                    mutableListOf<GenerateTextResponse>()

                responseMessageList.forEach { message ->
                    generateTextResponseList.add(createResponse(message))
                }

                call.respond(BatchGenerateTextResponse(results = generateTextResponseList))


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


private fun createResponse(message: Message): GenerateTextResponse {
    return GenerateTextResponse(
        text = message.text,
        aiVendor = message.aiConfig.first().aiVendor.name,
        conversationId = message.conversationId,
        messageId = message.messageId,
        inputTokens = message.inputTokens,
        outputTokens = message.outputTokens
    )
}
