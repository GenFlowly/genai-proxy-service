package com.genflowly.activity

import com.genflowly.Routes
import com.genflowly.models.BatchGenerateTextRequest
import com.genflowly.models.BatchGenerateTextResponse
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.post
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import models.GenerateTextResponse
import org.slf4j.LoggerFactory
import service.AIRequestManager

private val logger = LoggerFactory.getLogger("BatchGenerateTextRoute")

fun Route.registerBatchGenerateTextRoutes(
    aiRequestManager: AIRequestManager
) {
    authenticate("auth0") {
        post(Routes.BATCH_GENERATE_TEXT) {
            val batchRequest = call.receive<BatchGenerateTextRequest>()
            logger.info("Received BatchGenerateText request: size={}", batchRequest.requests.size)

            val results = coroutineScope {
                val conversationId = aiRequestManager
                    .getConversationId(batchRequest.requests[0]) // only
                // check first message for conversation id
                batchRequest.requests.map { request ->
                    async {
                        try {
                            aiRequestManager.handleRequest(
                                vendor = request.aiVendor,
                                model = request.model,
                                prompt = request.prompt,
                                customerId = request.customerId,
                                conversationId = conversationId,
                                selectedResponseId = request.selectedResponseId,
                                client = request.client
                            )
                        } catch (e: Exception) {
                            logger.error(
                                "Error processing request for vendor={} model={}",
                                request.aiVendor, request.model, e
                            ) // todo create error object
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

            call.respond(BatchGenerateTextResponse(results))
        }
    }
}
