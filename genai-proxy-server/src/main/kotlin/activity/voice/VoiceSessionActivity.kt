package com.genflowly.activity.voice

import com.genflowly.Routes
import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.service.ConversationService
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.fetchApiKey
import com.genflowly.utils.getAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.route
import io.ktor.client.*
import io.ktor.client.plugins.timeout
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.server.auth.authenticate
import io.ktor.server.routing.Route
import io.ktor.server.websocket.*
import io.ktor.websocket.*
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import models.AIConfig
import models.Message
import org.slf4j.LoggerFactory
import service.AIRequestManager

private val logger = LoggerFactory.getLogger("VoiceSessionRoute")

/**
 * Pseudo OpenAPI entry for the voice session WebSocket, injected via the
 * OpenApi plugin's postBuild hook. OpenAPI cannot describe WebSocket protocols
 * (and the route scanner drops webSocket routes), so this entry exists purely
 * to make the endpoint discoverable in /docs: a GET with a 101 response and
 * the full protocol in the description.
 */
fun voiceSessionSpecPath(): io.swagger.v3.oas.models.PathItem =
    io.swagger.v3.oas.models.PathItem().get(
        io.swagger.v3.oas.models.Operation().apply {
            operationId = "voiceSession"
            addTagsItem("Voice")
            summary = "Realtime voice conversation (WebSocket)"
            description = """
                |**This is a WebSocket endpoint** (`wss://`), shown here as GET only because
                |OpenAPI cannot describe WebSocket protocols. Do not call it as a plain HTTP GET.
                |
                |The voice counterpart of `POST /api/v1/generate-text-stream`: same auth, same
                |instruction (persona) system, same conversation store. Transcripts and token
                |usage are persisted to the conversation like text messages.
                |
                |### Connecting
                |Authenticate with an Auth0 JWT or developer API key (`Authorization: Bearer ...`).
                |Browsers cannot set WebSocket headers — pass the JWT as an `access_token` query
                |parameter instead.
                |
                |### Handshake
                |First frame from the client must be `session.init` (JSON text frame):
                |```json
                |{
                |  "type": "session.init",
                |  "aiConfig": {"aiVendor": "OPENAI", "model": "gpt-realtime-2.1", "maxTokens": 4096},
                |  "prompt": {"instructionId": "abc", "instructionVersion": "1"},
                |  "conversationId": null,
                |  "client": "web",
                |  "agentic": true,
                |  "voice": "marin"
                |}
                |```
                |`aiVendor` is `OPENAI` or `GEMINI` (Anthropic has no realtime voice API); pick a
                |`model` id from `POST /api/v1/voice/models`. `prompt`, `conversationId` and
                |`voice` are optional — a new conversation is created when none is given.
                |The server replies `{"type":"session.created","conversationId":"..."}` followed by
                |`{"type":"session.ready","input_rate":24000,"output_rate":24000,...}` — resample
                |microphone audio to `input_rate` (OpenAI 24 kHz, Gemini 16 kHz) and play back at
                |`output_rate` (24 kHz).
                |
                |### Client → server frames
                |- `{"type":"input_audio.append","audio":"<base64 PCM16>"}` — microphone chunks
                |- `{"type":"session.close"}` — end the session
                |
                |### Server → client frames
                |- `output_audio.delta` (base64 PCM16) / `output_audio.done`
                |- `transcript.delta` / `transcript.done` with `role` = `user` | `assistant`
                |- `tool.started` / `tool.completed` — knowledge-base (agent graph) lookups
                |- `usage` — per-turn token usage: `input_tokens`, `output_tokens`,
                |  `total_tokens`, `cache_read_tokens`
                |- `interrupted` — user barge-in: stop audio playback immediately
                |- `error` — terminal or vendor error
                |
                |Full protocol reference: genai-proxy-server README and
                |retrieval-server `voice/session.py`.
            """.trimMargin()
            responses = io.swagger.v3.oas.models.responses.ApiResponses().apply {
                addApiResponse(
                    "101",
                    io.swagger.v3.oas.models.responses.ApiResponse()
                        .description("Switching Protocols — connection upgraded to WebSocket")
                )
                addApiResponse(
                    "401",
                    io.swagger.v3.oas.models.responses.ApiResponse()
                        .description("Missing, invalid or revoked credentials")
                )
            }
            security = listOf(
                io.swagger.v3.oas.models.security.SecurityRequirement().addList("apiKey")
            )
        }
    )

private data class VoiceTurnUsage(
    val inputTokens: Int?,
    val outputTokens: Int?,
    val totalTokens: Int?,
    val cacheReadTokens: Int?
)

/**
 * Authenticated WebSocket API for realtime voice conversations — the voice
 * counterpart of the generate-text-stream API. Same concepts, same persistence:
 * instruction (persona), conversation continuation, and message storage in the
 * Conversation/Message tables so voice exchanges appear in history like text.
 *
 * Client sends a `session.init` frame shaped like a GenerateText request:
 *
 *   {"type": "session.init",
 *    "aiConfig": {"aiVendor": "OPENAI"|"GEMINI", "model": "gpt-realtime-2.1", "maxTokens": 4096},
 *    "prompt": {"instructionId": "...", "instructionVersion": "1"},   // optional
 *    "conversationId": "...",                                        // optional — new one created if absent
 *    "client": "web",
 *    "agentic": true,                                                // graph tool uses the agent graph
 *    "voice": "marin"}                                               // optional vendor voice name
 *
 * The proxy resolves the customerId and vendor API key (never sent to the
 * client), resolves the instruction into the system prompt, resolves/creates
 * the conversation (enforcing write access), loads prior messages as context
 * for the voice model, then replies `{"type":"session.created","conversationId":...}`
 * and relays frames to the retrieval server's /voice endpoint. Transcripts
 * (`transcript.done` events from either provider) are persisted as user /
 * assistant messages chained onto the conversation as they arrive.
 *
 * Audio protocol (rates, event types) is documented in retrieval-server
 * voice/session.py; use /api/v1/voice/models to pick a valid model id.
 */
fun Route.registerVoiceSessionRoutes(
    customerProfileService: CustomerProfileService,
    conversationService: ConversationService,
    aiRequestManager: AIRequestManager,
    httpClient: HttpClient,
    json: Json
) {
    val retrievalServerUrl: String =
        System.getenv("RETRIEVAL_SERVER_URL") ?: "http://retrieval-server:5001"
    // http -> ws, https -> wss
    val retrievalWsUrl = retrievalServerUrl.replaceFirst("http", "ws") + "/voice"

    authenticate("auth0", "apiKey") {
        route(Routes.VOICE_SESSION, {
            tags("Voice")
            summary = "Realtime voice conversation (WebSocket)"
            description = "WebSocket endpoint (wss) — the voice counterpart of " +
                    "generate-text-stream. Connect with an Auth0 JWT or developer API key " +
                    "(browsers may pass the JWT as an `access_token` query parameter), then " +
                    "send a `session.init` JSON frame with `aiConfig {aiVendor, model, " +
                    "maxTokens}`, optional `prompt {instructionId, instructionVersion}`, " +
                    "optional `conversationId`, `client`, `agentic` and `voice`. The server " +
                    "replies `session.created` with the conversationId, then relays realtime " +
                    "events: `session.ready` (audio sample rates), `output_audio.delta` " +
                    "(base64 PCM16), `transcript.delta/done`, `tool.started/completed`, " +
                    "`usage`, `interrupted`, `error`. Transcripts and token usage are " +
                    "persisted to the conversation like text messages. Pick a model id from " +
                    "POST ${Routes.GET_VOICE_MODELS}. Full protocol: genai-proxy-server " +
                    "README and retrieval-server voice/session.py."
        }) {
            webSocket {
            val clientSession = this

            suspend fun reject(message: String) {
                logger.warn("Voice session rejected: {}", message)
                clientSession.send(Frame.Text(buildJsonObject {
                    put("type", "error")
                    put("message", message)
                }.toString()))
                clientSession.close(CloseReason(CloseReason.Codes.VIOLATED_POLICY, message.take(120)))
            }

            val customerId = clientSession.call.getAuthenticatedCustomerId(customerProfileService)
            if (customerId == null) {
                return@webSocket reject("Customer profile not found")
            }

            val initText = (clientSession.incoming.receiveCatching().getOrNull() as? Frame.Text)
                ?.readText()
                ?: return@webSocket reject("Expected a session.init text frame")

            val init = try {
                json.parseToJsonElement(initText).jsonObject
            } catch (e: Exception) {
                return@webSocket reject("session.init is not valid JSON")
            }
            if (init["type"]?.jsonPrimitive?.content != "session.init") {
                return@webSocket reject("First message must be session.init")
            }

            // --- Resolve vendor + model from aiConfig (same shape as generate-text) ---
            val aiConfigJson = init["aiConfig"]?.jsonObject
                ?: return@webSocket reject("Missing aiConfig")
            val vendorName = aiConfigJson["aiVendor"]?.jsonPrimitive?.content
            val vendor = when (vendorName) {
                "OPENAI" -> AIVendor.OPENAI
                "GEMINI" -> AIVendor.GEMINI
                else -> null
            } ?: return@webSocket reject(
                "Unsupported voice vendor: '$vendorName' (use OPENAI or GEMINI; CLAUDE has no realtime voice API)"
            )
            val model = aiConfigJson["model"]?.jsonPrimitive?.content
                ?: return@webSocket reject("Missing aiConfig.model")
            val maxTokens = aiConfigJson["maxTokens"]?.jsonPrimitive?.content?.toIntOrNull()
            val client = init["client"]?.jsonPrimitive?.content ?: "voice"
            val agentic = init["agentic"]?.jsonPrimitive?.content?.toBooleanStrictOrNull() ?: true

            val apiKey = fetchApiKey(vendor, customerId, customerProfileService)
                ?: return@webSocket reject("No API key stored for $vendorName")

            // --- Resolve instruction (persona) into the system prompt ---
            val promptJson = init["prompt"]?.jsonObject
            val instructionId = promptJson?.get("instructionId")?.jsonPrimitive?.content ?: ""
            val instructionVersion = promptJson?.get("instructionVersion")?.jsonPrimitive?.content ?: ""
            val systemPrompt = if (instructionId.isNotBlank()) {
                customerProfileService.getInstructionVersion(
                    customerId, instructionId, instructionVersion.toIntOrNull() ?: 1
                )?.instruction ?: ""
            } else ""

            // --- Resolve or create the conversation (enforces write access) ---
            val requestedConversationId = init["conversationId"]?.jsonPrimitive?.content
            val conversationId = try {
                aiRequestManager.getConversationId(customerId, client, requestedConversationId)
            } catch (e: Exception) {
                return@webSocket reject("Cannot use conversation: ${e.message}")
            }

            if (instructionId.isNotBlank()) {
                customerProfileService.trackInstructionUsage(customerId, conversationId, instructionId)
            }

            // --- Load prior messages as context for the voice model ---
            var lastMessageId: String? = conversationService.getLatestMessageId(conversationId)
            val thread = lastMessageId?.let { conversationService.getMessageThread(conversationId, it) }
                ?: emptyList()

            val aiConfig = AIConfig(aiVendor = vendor, model = model, maxTokens = maxTokens)
            val credentialKey = if (vendor == AIVendor.OPENAI) "openai_api_key" else "gemini_api_key"
            val provider = if (vendor == AIVendor.OPENAI) "openai" else "gemini"

            val upstreamInit = buildJsonObject {
                put("type", "session.init")
                put("provider", provider)
                put("model", model)
                init["voice"]?.let { put("voice", it) }
                init["graphModel"]?.let { put("graph_model", it) }
                if (systemPrompt.isNotBlank()) put("system_prompt", systemPrompt)
                put("agentic", agentic)
                put("customer_id", customerId)
                put("client", client)
                maxTokens?.let { put("llm_max_tokens", it) }
                put("llm_credentials", buildJsonObject { put(credentialKey, apiKey) })
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

            // Latest per-turn usage from the vendor; adapters emit it just before
            // the assistant transcript.done, so it lands on the assistant message
            // exactly like the text-generation flow.
            var capturedUsage: VoiceTurnUsage? = null

            suspend fun persistTranscript(role: String, text: String) {
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

            try {
                httpClient.webSocket(retrievalWsUrl, request = {
                    timeout {
                        requestTimeoutMillis = io.ktor.client.plugins.HttpTimeoutConfig.INFINITE_TIMEOUT_MS
                        socketTimeoutMillis = io.ktor.client.plugins.HttpTimeoutConfig.INFINITE_TIMEOUT_MS
                    }
                }) {
                    val upstream = this
                    upstream.send(Frame.Text(upstreamInit.toString()))

                    clientSession.send(Frame.Text(buildJsonObject {
                        put("type", "session.created")
                        put("conversationId", conversationId)
                    }.toString()))

                    val clientToUpstream = launch {
                        for (frame in clientSession.incoming) {
                            if (frame is Frame.Text) upstream.send(Frame.Text(frame.readText()))
                        }
                        upstream.close(CloseReason(CloseReason.Codes.NORMAL, "client disconnected"))
                    }
                    try {
                        for (frame in upstream.incoming) {
                            if (frame !is Frame.Text) continue
                            val text = frame.readText()

                            // Persist finished transcripts (with usage) as conversation messages
                            try {
                                val event = json.parseToJsonElement(text).jsonObject
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

                            clientSession.send(Frame.Text(text))
                        }
                    } finally {
                        clientToUpstream.cancel()
                    }
                }
            } catch (e: Exception) {
                logger.error("Voice session relay failed for customer=$customerId", e)
                try {
                    clientSession.send(Frame.Text("""{"type":"error","message":"Voice relay failed"}"""))
                } catch (_: Exception) {
                }
            } finally {
                try {
                    clientSession.close(CloseReason(CloseReason.Codes.NORMAL, "session ended"))
                } catch (_: Exception) {
                }
                logger.info("Voice session ended: customer={}, conversation={}", customerId, conversationId)
            }
            }
        }
    }
}
