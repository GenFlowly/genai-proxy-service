package com.genflowly.activity.voice

import com.genflowly.Routes
import com.genflowly.models.api.AttachVoiceCallRequest
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.SendVoiceCallEventsRequest
import com.genflowly.models.api.VoiceCallRefRequest
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.VoiceSessionService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route

/**
 * Server-side control channel for browser-held WebRTC Realtime calls (the
 * companion to ${Routes.VOICE_CLIENT_SECRET}): the browser keeps the audio
 * leg; these endpoints let the customer's backend steer the same live session
 * through genflowly — session.update, injected conversation items, tool
 * declaration + webhook relay, usage metering.
 */
fun Route.registerVoiceCallControlRoutes(
    customerProfileService: CustomerProfileService,
    voiceSessionService: VoiceSessionService
) {
    authenticate("auth0", "apiKey") {
        post(Routes.VOICE_CALL_ATTACH, {
            tags("Voice")
            summary = "Attach a control channel to a live WebRTC Realtime call"
            description = "Opens a server-side WebSocket to the same Realtime session the " +
                    "browser holds over WebRTC (wss://api.openai.com/v1/realtime?call_id=…), " +
                    "authenticated with the customer's stored OPENAI vendor key. The callId " +
                    "comes from the Location header of the browser's SDP exchange. Optionally " +
                    "applies an initial session.update (e.g. tool declarations) and registers a " +
                    "webhook that receives the model's function calls " +
                    "({call_id, tool_call_id, name, arguments} → respond {\"output\": \"…\"}); " +
                    "outputs are fed back into the session automatically. Usage from every " +
                    "response.done is accumulated and returned by the status/detach endpoints. " +
                    "Attach is idempotent per call. The channel dies with the call; detach to " +
                    "close it early and collect the final usage summary."
            request { body<AttachVoiceCallRequest> { required = true } }
            response {
                code(HttpStatusCode.OK) { description = "Attach status: {attached, usage, …} or {attached: false, error}" }
                code(HttpStatusCode.BadRequest) { description = "Missing callId"; body<ErrorResponse>() }
            }
        }) {
            val request = call.receive<AttachVoiceCallRequest>()
            val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
            if (request.callId.isBlank()) {
                call.respond(HttpStatusCode.BadRequest, ErrorResponse("callId is required"))
                return@post
            }
            call.respond(voiceSessionService.attachCallControl(customerId, request))
        }

        post(Routes.VOICE_CALL_EVENTS, {
            tags("Voice")
            summary = "Send Realtime client events over a call's control channel"
            description = "Forwards raw Realtime client events to the attached session. Allowed " +
                    "types: session.update, conversation.item.create, conversation.item.delete, " +
                    "response.create, response.cancel — audio-buffer events belong to the " +
                    "browser leg and are refused. Typical use: steering injections " +
                    "(conversation.item.create with a system message) and mid-session " +
                    "instruction updates (session.update)."
            request { body<SendVoiceCallEventsRequest> { required = true } }
            response {
                code(HttpStatusCode.OK) { description = "{sent: n} or {sent: 0, error}" }
            }
        }) {
            val request = call.receive<SendVoiceCallEventsRequest>()
            val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
            call.respond(voiceSessionService.sendCallEvents(customerId, request))
        }

        post(Routes.VOICE_CALL_STATUS, {
            tags("Voice")
            summary = "Status + accumulated usage for an attached call"
            request { body<VoiceCallRefRequest> { required = true } }
            response { code(HttpStatusCode.OK) { description = "{attached, usage, tool_calls_relayed, …}" } }
        }) {
            val request = call.receive<VoiceCallRefRequest>()
            val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
            call.respond(voiceSessionService.callStatus(customerId, request.callId))
        }

        post(Routes.VOICE_CALL_DETACH, {
            tags("Voice")
            summary = "Close a call's control channel"
            description = "Closes the server-side WebSocket and returns the final usage summary. " +
                    "Does not end the browser's call."
            request { body<VoiceCallRefRequest> { required = true } }
            response { code(HttpStatusCode.OK) { description = "Final summary: {attached: false, usage, …}" } }
        }) {
            val request = call.receive<VoiceCallRefRequest>()
            val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
            call.respond(voiceSessionService.detachCall(customerId, request.callId))
        }
    }
}
