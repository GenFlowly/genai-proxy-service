package com.genflowly.models.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * Attach genflowly's server-side control channel to a live WebRTC Realtime
 * call. The browser holds the audio leg; this opens
 * wss://api.openai.com/v1/realtime?call_id=... with the customer's stored
 * OPENAI key for steering, tool relay, metering and policy.
 */
@Serializable
data class AttachVoiceCallRequest(
    /** From the Location header of the browser's SDP exchange (rtc_...) */
    val callId: String,
    /** Optional initial session.update payload — e.g. tool declarations */
    val sessionUpdate: JsonObject? = null,
    /** POSTed the model's function calls: {call_id, tool_call_id, name, arguments} → {"output": "..."} */
    val webhookUrl: String? = null,
    /** Echoed back as X-Genflowly-Webhook-Secret on webhook calls */
    val webhookSecret: String? = null,
)

@Serializable
data class SendVoiceCallEventsRequest(
    val callId: String,
    /**
     * Raw Realtime client events, forwarded verbatim. Allowed types:
     * session.update, conversation.item.create, conversation.item.delete,
     * response.create, response.cancel.
     */
    val events: List<JsonObject>,
)

@Serializable
data class VoiceCallRefRequest(val callId: String)
