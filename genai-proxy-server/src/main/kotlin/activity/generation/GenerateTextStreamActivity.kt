package com.genflowly.activity.generation

import com.genflowly.ResponseHeaders
import com.genflowly.Routes
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.bearerToken
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.header
import io.ktor.server.response.respondTextWriter
import io.ktor.server.routing.Route
import io.github.smiley4.ktoropenapi.post
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.GenerateTextStreamRequest
import com.genflowly.models.retrieval.localeFromAcceptLanguage
import org.slf4j.LoggerFactory
import com.genflowly.service.ExchangeSideEffects
import com.genflowly.service.GenerationOrchestrator

private val logger = LoggerFactory.getLogger("GenerateTextStreamRoute")

fun Route.registerGenerateTextStreamRoutes(
    generationOrchestrator: GenerationOrchestrator,
    customerProfileService: CustomerProfileService,
    exchangeSideEffects: ExchangeSideEffects,
    /** Log request payloads (user content) — off in production, see Routing.kt. */
    logContent: Boolean = false
) {
    authenticate("auth0", "apiKey") {
        post(Routes.GENERATE_TEXT_STREAM, {
            tags("Generation")
            summary = "Generate an AI text response as a stream"
            description = "Streams the generated text incrementally as plain-text chunks " +
                    "(Transfer-Encoding: chunked). Conversation and message metadata is returned " +
                    "in response headers, not the body. The first byte is a heartbeat space " +
                    "character sent before generation starts. Image input: upload images via " +
                    "POST /attachments first, then reference them in prompt.attachments — " +
                    "they are passed to vision-capable models alongside the prompt text. " +
                    "Tool use: pass tools and the model's tool calls arrive as a " +
                    "{\"t\":\"tc\",\"v\":[{id,name,args}]} stream event; execute them and send a " +
                    "follow-up request with toolResults (and selectedResponseId set to the " +
                    "X-Response-Message-Id header value) to get the final answer. " +
                    "Structured output: pass responseSchema (a JSON Schema object) and the " +
                    "response is guaranteed-parseable JSON matching that schema; because the " +
                    "JSON is only valid once complete, it arrives as one content chunk when " +
                    "generation finishes instead of token by token. Mutually exclusive with tools."
            request {
                body<GenerateTextStreamRequest> {
                    description = "Prompt, a single AI vendor configuration and conversation context"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Plain-text stream of generated text chunks"
                    body<String> { mediaTypes(ContentType.Text.Plain) }
                    header<String>(ResponseHeaders.CONVERSATION_ID) { description = "Conversation this exchange belongs to" }
                    header<String>(ResponseHeaders.MESSAGE_ID) { description = "ID of the stored user message" }
                    header<String>(ResponseHeaders.RESPONSE_MESSAGE_ID) { description = "ID of the stored assistant message" }
                    header<String>(ResponseHeaders.AI_VENDOR) { description = "AI vendor that served the request" }
                }
                code(HttpStatusCode.BadRequest) {
                    description = "Malformed request body"
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
            call.handleGenerationErrors(logger, "GenerateTextStream") {
                val request = call.receive<GenerateTextStreamRequest>()

                val customerId = call.requireAuthenticatedCustomerId(
                    customerProfileService
                )

                logger.info(
                    "Received GenerateTextStream request from customerId {} — client={} conversationId={} " +
                            "agentic={} vendor={} tools={} toolResults={} attachments={} agentId={}",
                    customerId, request.client, request.conversationId, request.agentic,
                    request.aiConfig.aiVendor, request.tools.size,
                    request.toolResults.size, request.prompt.attachments.size, request.agentId
                )
                if (logContent) {
                    logger.info("GenerateTextStream request payload: {}", request)
                }

                call.response.header(HttpHeaders.CacheControl, "no-cache, no-transform")
                call.response.header(HttpHeaders.Connection, "keep-alive")
                call.response.header(ResponseHeaders.ACCEL_BUFFERING, "no")

                // The browser's preferred locale (e.g. "en-US"), for locale-aware tools.
                val locale = localeFromAcceptLanguage(call.request.headers[HttpHeaders.AcceptLanguage])

                val streamResult = generationOrchestrator.processTextGenerateStreamRequest(
                    listOf(request.aiConfig),
                    request.prompt.instructionId,
                    request.prompt.instructionVersion,
                    request.prompt.prompt,
                    request.conversationId,
                    request.selectedResponseId,
                    request.client,
                    customerId,
                    request.agentic,
                    request.prompt.attachments,
                    request.tools,
                    request.toolChoice,
                    request.toolResults,
                    request.responseSchema,
                    request.useLearnedPreferences,
                    request.agentId,
                    request.projectId,
                    locale = locale
                )

                call.response.header(ResponseHeaders.CONVERSATION_ID, streamResult.conversationId)
                call.response.header(ResponseHeaders.MESSAGE_ID, streamResult.messageId)
                call.response.header(ResponseHeaders.RESPONSE_MESSAGE_ID, streamResult.responseMessageId)
                call.response.header(ResponseHeaders.AI_VENDOR, request.aiConfig.aiVendor.toString())

                if (streamResult.appliedInstructionId.isNotBlank()) {
                    call.response.header(ResponseHeaders.INSTRUCTION_ID, streamResult.appliedInstructionId)
                    if (streamResult.appliedInstructionVersion.isNotBlank()) {
                        call.response.header(ResponseHeaders.INSTRUCTION_VERSION, streamResult.appliedInstructionVersion)
                    }
                }

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

                exchangeSideEffects.launchAsync(
                    customerId = customerId,
                    conversationId = streamResult.conversationId,
                    client = request.client,
                    userText = request.prompt.prompt,
                    responseMessageId = streamResult.responseMessageId,
                    bearerToken = call.bearerToken(),
                    learnFromConversation = request.learnFromConversation
                )
            }
        }
    }
}
