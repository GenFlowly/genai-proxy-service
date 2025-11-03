package com.genflowly.activity

import com.genflowly.Routes
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.post
import models.GenerateTextRequest
import models.GenerateTextResponse
import org.slf4j.LoggerFactory
import service.AIRequestManager

private val logger = LoggerFactory.getLogger("GenerateTextRoute")

fun Route.registerGenerateTextRoutes(
    aiRequestManager: AIRequestManager
) {
    authenticate("auth0") {
        post(Routes.GENERATE_TEXT) {
            val request = call.receive<GenerateTextRequest>()
            logger.info(
                "Received GenerateText request: vendor={}, model={}, promptLength={}",
                request.vendor, request.model, request.prompt.length
            )

            val startTime = System.currentTimeMillis()

            try {
                val response = aiRequestManager.handleRequest(
                    vendor = request.vendor,
                    model = request.model,
                    prompt = request.prompt,
                    customerId = request.customerId,
                    conversationId = request.conversationId,
                    selectedResponseId = request.selectedResponseId,
                    client = request.client
                )

                val durationMs = System.currentTimeMillis() - startTime

                logger.info(
                    "AI response received: vendor={}, model={}, durationMs={},",
                    request.vendor,
                    request.model,
                    durationMs,
                )

                call.respond(response)

            } catch (e: Exception) {
                logger.error(
                    "Error generating text: vendor={}, model={}, message={}",
                    request.vendor, request.model, e.message, e
                )
                call.respond(
                    GenerateTextResponse(
                        text = "[Error: ${e.message}]",
                        messageId = null,
                        conversationId = null
                    )
                )
            }
        }
    }
}
