package com.genflowly.service

import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.providers.RetrievalServerClient
import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import models.AIConfig
import models.Message
import models.toCredentialKey
import models.toProviderString
import org.slf4j.LoggerFactory

private data class VoiceTurnUsage(
    val inputTokens: Int?,
    val outputTokens: Int?,
    val totalTokens: Int?,
    val cacheReadTokens: Int?
)

/**
 * Business logic behind the realtime voice WebSocket: session.init handshake
 * validation, credential/instruction/conversation resolution, upstream init
 * payload construction, and per-turn transcript + usage persistence. The
 * activity keeps only the WebSocket transport (frame relay and lifecycle).
 */
class VoiceSessionService(
    private val conversationService: ConversationService,
    private val generationOrchestrator: GenerationOrchestrator,
    private val instructionService: InstructionService,
    private val customerCredentialsService: CustomerCredentialsService,
    private val retrievalServerClient: RetrievalServerClient,
    private val json: Json
) {
    private val logger = LoggerFactory.getLogger("VoiceSessionService")

    /** Opens the upstream retrieval-server voice WebSocket and runs [handler] on it. */
    suspend fun connectUpstream(handler: suspend DefaultClientWebSocketSession.() -> Unit) =
        retrievalServerClient.voiceSession(handler)

    sealed class SessionInitResult {
        /** Handshake invalid — send the message to the client and close. */
        data class Rejected(val message: String) : SessionInitResult()
        data class Ready(val session: VoiceSession) : SessionInitResult()
    }

    /**
     * Validates the session.init frame and resolves everything a voice session
     * needs: vendor + model, API key, system prompt, conversation (created or
     * write-access-checked) and prior message history.
     */
    suspend fun initSession(customerId: String, initText: String): SessionInitResult {
        val init = try {
            json.parseToJsonElement(initText).jsonObject
        } catch (e: Exception) {
            return SessionInitResult.Rejected("session.init is not valid JSON")
        }
        if (init["type"]?.jsonPrimitive?.content != "session.init") {
            return SessionInitResult.Rejected("First message must be session.init")
        }

        // --- Resolve vendor + model from aiConfig (same shape as generate-text) ---
        val aiConfigJson = init["aiConfig"]?.jsonObject
            ?: return SessionInitResult.Rejected("Missing aiConfig")
        val vendorName = aiConfigJson["aiVendor"]?.jsonPrimitive?.content
        val vendor = when (vendorName) {
            "OPENAI" -> AIVendor.OPENAI
            "GEMINI" -> AIVendor.GEMINI
            else -> null
        } ?: return SessionInitResult.Rejected(
            "Unsupported voice vendor: '$vendorName' (use OPENAI or GEMINI; CLAUDE has no realtime voice API)"
        )
        val model = aiConfigJson["model"]?.jsonPrimitive?.content
            ?: return SessionInitResult.Rejected("Missing aiConfig.model")
        val maxTokens = aiConfigJson["maxTokens"]?.jsonPrimitive?.content?.toIntOrNull()
        val client = init["client"]?.jsonPrimitive?.content ?: "voice"
        val agentic = init["agentic"]?.jsonPrimitive?.content?.toBooleanStrictOrNull() ?: true

        val apiKey = customerCredentialsService.getCustomerApiKeyForVendor(vendor, customerId)
            ?: return SessionInitResult.Rejected("No API key stored for $vendorName")

        // --- Resolve instruction (persona) into the system prompt ---
        val promptJson = init["prompt"]?.jsonObject
        val instructionId = promptJson?.get("instructionId")?.jsonPrimitive?.content ?: ""
        val instructionVersion = promptJson?.get("instructionVersion")?.jsonPrimitive?.content ?: ""
        val systemPrompt = if (instructionId.isNotBlank()) {
            instructionService.getInstructionVersion(
                customerId, instructionId, instructionVersion.toIntOrNull() ?: 1
            )?.instruction ?: ""
        } else ""

        // --- Resolve or create the conversation (enforces write access) ---
        val requestedConversationId = init["conversationId"]?.jsonPrimitive?.content
        val conversationId = try {
            generationOrchestrator.getConversationId(customerId, client, requestedConversationId)
        } catch (e: Exception) {
            return SessionInitResult.Rejected("Cannot use conversation: ${e.message}")
        }

        if (instructionId.isNotBlank()) {
            instructionService.trackInstructionUsage(customerId, conversationId, instructionId)
        }

        // --- Load prior messages as context for the voice model ---
        val lastMessageId: String? = conversationService.getLatestMessageId(conversationId)
        val thread = lastMessageId?.let { conversationService.getMessageThread(conversationId, it) }
            ?: emptyList()

        val aiConfig = AIConfig(aiVendor = vendor, model = model, maxTokens = maxTokens)

        val upstreamInit = buildJsonObject {
            put("type", "session.init")
            put("provider", vendor.toProviderString())
            put("model", model)
            init["voice"]?.let { put("voice", it) }
            init["graphModel"]?.let { put("graph_model", it) }
            if (systemPrompt.isNotBlank()) put("system_prompt", systemPrompt)
            put("agentic", agentic)
            put("customer_id", customerId)
            put("client", client)
            maxTokens?.let { put("llm_max_tokens", it) }
            put("llm_credentials", buildJsonObject { put(vendor.toCredentialKey(), apiKey) })
            put("conversation_history", buildJsonArray {
                thread.forEach { msg ->
                    add(buildJsonObject {
                        put("role", msg.role)
                        put("content", msg.text)
                    })
                }
            })
        }

        logger.info(
            "Voice conversation starting: customer={}, vendor={}, model={}, conversation={}, historyTurns={}",
            customerId, vendorName, model, conversationId, thread.size
        )

        return SessionInitResult.Ready(
            VoiceSession(
                conversationId = conversationId,
                upstreamInit = upstreamInit,
                customerId = customerId,
                client = client,
                systemPrompt = systemPrompt,
                instructionId = instructionId,
                instructionVersion = instructionVersion,
                aiConfig = aiConfig,
                lastMessageId = lastMessageId
            )
        )
    }

    /**
     * Per-connection session state: the upstream init payload plus transcript
     * persistence that chains messages onto the conversation as they arrive.
     */
    inner class VoiceSession(
        val conversationId: String,
        val upstreamInit: JsonObject,
        private val customerId: String,
        private val client: String,
        private val systemPrompt: String,
        private val instructionId: String,
        private val instructionVersion: String,
        private val aiConfig: AIConfig,
        private var lastMessageId: String?
    ) {
        // Latest per-turn usage from the vendor; adapters emit it just before
        // the assistant transcript.done, so it lands on the assistant message
        // exactly like the text-generation flow.
        private var capturedUsage: VoiceTurnUsage? = null

        /**
         * Inspects an upstream event frame: captures usage events and persists
         * finished transcripts as conversation messages. Non-JSON or unrelated
         * frames are ignored — the caller relays every frame regardless.
         */
        suspend fun handleUpstreamEvent(frameText: String) {
            try {
                val event = json.parseToJsonElement(frameText).jsonObject
                when (event["type"]?.jsonPrimitive?.content) {
                    "usage" -> {
                        val usage = event["usage"]?.jsonObject
                        capturedUsage = VoiceTurnUsage(
                            inputTokens = usage?.get("input_tokens")?.jsonPrimitive?.content?.toIntOrNull(),
                            outputTokens = usage?.get("output_tokens")?.jsonPrimitive?.content?.toIntOrNull(),
                            totalTokens = usage?.get("total_tokens")?.jsonPrimitive?.content?.toIntOrNull(),
                            cacheReadTokens = usage?.get("cache_read_tokens")?.jsonPrimitive?.content?.toIntOrNull()
                        )
                    }
                    "transcript.done" -> persistTranscript(
                        role = event["role"]?.jsonPrimitive?.content ?: "user",
                        text = event["text"]?.jsonPrimitive?.content ?: ""
                    )
                }
            } catch (_: Exception) {
                // Non-JSON or unexpected frame — just relay it
            }
        }

        private suspend fun persistTranscript(role: String, text: String) {
            if (text.isBlank()) return
            val usage = if (role == "assistant") capturedUsage else null
            val message = Message(
                conversationId = conversationId,
                customerId = customerId,
                client = client,
                role = role,
                text = text,
                previousMessageId = lastMessageId,
                aiConfig = listOf(aiConfig),
                systemPrompt = systemPrompt,
                instructionId = instructionId.takeIf { it.isNotBlank() },
                instructionVersion = instructionVersion.takeIf { it.isNotBlank() },
                inputTokens = usage?.inputTokens,
                outputTokens = usage?.outputTokens,
                totalTokens = usage?.totalTokens,
                tokensReadFromCache = usage?.cacheReadTokens
            )
            if (role == "assistant") capturedUsage = null
            try {
                conversationService.addMessageInConversation(message)
                lastMessageId = message.messageId
                logger.info(
                    "Persisted voice {} transcript {} in conversation {}",
                    role, message.messageId, conversationId
                )
            } catch (e: Exception) {
                logger.error("Failed to persist voice transcript in conversation $conversationId", e)
            }
        }
    }
}
