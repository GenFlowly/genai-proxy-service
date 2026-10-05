package com.genflowly.models.api

import kotlinx.serialization.Serializable

/**
 * Request to mint an OpenAI Realtime ephemeral client secret for a browser
 * WebRTC voice session. The customer's stored OPENAI vendor key performs the
 * mint server-side; only the short-lived secret is returned.
 */
@Serializable
data class CreateVoiceClientSecretRequest(
    /** Realtime model id, e.g. "gpt-realtime-2.1" */
    val model: String,
    /** Full system instruction the voice session runs with (baked in at mint time) */
    val instructions: String,
    /** Output voice, e.g. "marin" — vendor default when omitted */
    val voice: String? = null,
    /**
     * Input-audio transcription model (e.g. "whisper-1"). Best-effort: if the
     * vendor rejects the session config with it, the mint is retried without.
     */
    val inputTranscriptionModel: String? = null,
)

@Serializable
data class CreateVoiceClientSecretResponse(
    /** The ephemeral client secret ("ek_..."), redeemable once against OpenAI's /v1/realtime/calls */
    val value: String,
    /** Expiry, unix seconds (typically ~60s after minting) */
    val expiresAt: Long? = null,
    val model: String,
)
