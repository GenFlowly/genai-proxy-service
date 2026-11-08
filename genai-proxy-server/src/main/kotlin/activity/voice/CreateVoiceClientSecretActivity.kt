package com.genflowly.activity.voice

import com.genflowly.Routes
import com.genflowly.models.api.CreateVoiceClientSecretRequest
import com.genflowly.models.api.CreateVoiceClientSecretResponse
import com.genflowly.models.api.ErrorResponse
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.VoiceSessionService
import com.genflowly.utils.ensureAiDataConsent
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("CreateVoiceClientSecretRoute")

fun Route.registerVoiceClientSecretRoutes(
    customerProfileService: CustomerProfileService,
    voiceSessionService: VoiceSessionService
) {
    authenticate("auth0", "apiKey") {
        post(Routes.VOICE_CLIENT_SECRET, {
            tags("Voice")
            summary = "Mint an OpenAI Realtime ephemeral client secret"
            description = "Exchanges the customer's stored OPENAI vendor key for a short-lived " +
                    "Realtime client secret (OpenAI POST /v1/realtime/client_secrets), performed " +
                    "entirely server-side — the vendor key never leaves genflowly. Use this when a " +
                    "browser client connects to OpenAI's Realtime API over WebRTC directly " +
                    "(redeeming the secret once against /v1/realtime/calls) instead of streaming " +
                    "through the genflowly voice WebSocket (${Routes.VOICE_SESSION}). The session's " +
                    "model, voice and system instructions are fixed at mint time and cannot be " +
                    "changed by the secret's holder. Secrets expire in roughly one minute; mint " +
                    "one per session start, on demand. Requires an OPENAI vendor key stored on " +
                    "the account. Note: genflowly does not persist or bill these sessions — the " +
                    "audio flows browser↔OpenAI and usage lands on the stored OpenAI key."
            request {
                body<CreateVoiceClientSecretRequest> {
                    description = "Realtime session configuration to bake into the secret"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Ephemeral client secret, redeemable once"
                    body<CreateVoiceClientSecretResponse>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "Missing model or instructions"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.UnprocessableEntity) {
                    description = "No stored OPENAI key, or the vendor rejected the mint"
                    body<ErrorResponse>()
                }
            }
        }) {
            val request = call.receive<CreateVoiceClientSecretRequest>()
            val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
            if (!call.ensureAiDataConsent(customerProfileService)) return@post

            if (request.model.isBlank() || request.instructions.isBlank()) {
                call.respond(
                    HttpStatusCode.BadRequest,
                    ErrorResponse("model and instructions are required")
                )
                return@post
            }

            val result = voiceSessionService.createClientSecret(customerId, request)
            val value = result.value
            if (value == null) {
                logger.info(
                    "Client-secret mint failed for customerId {}: {}",
                    customerId, result.error
                )
                call.respond(
                    HttpStatusCode.UnprocessableEntity,
                    ErrorResponse(result.error ?: "Failed to mint client secret")
                )
                return@post
            }

            call.respond(
                CreateVoiceClientSecretResponse(
                    value = value,
                    expiresAt = result.expiresAt,
                    model = request.model,
                )
            )
        }
    }
}
