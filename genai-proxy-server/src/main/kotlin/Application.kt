package com.genflowly


import com.auth0.jwk.JwkProviderBuilder
import com.genflowly.aicallerlib.di.commonModule
import com.genflowly.di.appModule
import com.genflowly.service.AIRequestService
import io.github.smiley4.ktoropenapi.OpenApi
import io.github.smiley4.ktoropenapi.config.AuthScheme
import io.github.smiley4.ktoropenapi.config.AuthType
import com.genflowly.service.ConversationService
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.auth.HttpAuthHeader
import io.ktor.server.auth.parseAuthorizationHeader
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.auth.Authentication
import io.ktor.server.auth.jwt.JWTCredential
import io.ktor.server.auth.jwt.JWTPrincipal
import io.ktor.server.auth.jwt.jwt
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.plugins.cors.routing.CORS
import java.util.concurrent.TimeUnit
import org.koin.core.context.startKoin
import org.koin.ktor.ext.get
import org.slf4j.LoggerFactory
import service.AIRequestManager
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.AIModelsService
import com.genflowly.service.ApiKeyPrincipal
import com.genflowly.service.DeveloperApiKeyService
import com.genflowly.service.GraphService
import com.genflowly.service.NotesService
import io.ktor.server.auth.bearer


fun main(args: Array<String>) {
    io.ktor.server.netty.EngineMain.main(args)
}

private val logger = LoggerFactory.getLogger("Application")


fun validateCredentials(credential: JWTCredential): JWTPrincipal? {
    val auth0Audience = System.getenv("AUTH0_API_AUDIENCE")
        ?: error("AUTH0_API_AUDIENCE not set")
    val containsAudience = credential.payload.audience.contains(auth0Audience)

    if (containsAudience) {
        return JWTPrincipal(credential.payload)
    }

    return null
}

fun Application.module() {
    install(ContentNegotiation) {
        json()
    }

    install(io.ktor.server.websocket.WebSockets) {
        pingPeriodMillis = 30_000
        timeoutMillis = 60_000
    }

    install(OpenApi) {
        // OpenAPI cannot describe WebSocket routes, so the voice session
        // endpoint is injected as a documented pseudo-entry (GET + 101)
        postBuild = { spec, _ ->
            spec.path(Routes.VOICE_SESSION, com.genflowly.activity.voice.voiceSessionSpecPath())
        }
        info {
            title = "GenAI Proxy Service API"
            version = "1.0.0"
            description = """
                REST API for the GenAI proxy service: AI text generation across vendors,
                conversation and instruction management, customer onboarding and configuration.
                Supports image input on generation requests — see the Attachments tag for the
                upload flow — and tool use (function calling) across all vendors, described below.

                Authenticate with a developer API key, created in the web app under
                Settings → Developer. Pass it on every request as
                `Authorization: Bearer gfy_...`. Keys are shown once at creation and can be
                revoked at any time from the same page. A few web-app-only endpoints
                (onboarding, profile, user search, notes) additionally require an Auth0 session
                and are marked as such in their descriptions.

                ## Tool use (function calling)

                Generation requests accept caller-defined tools; one definition format works
                across OpenAI, Claude and Gemini. Your code executes the tools — the API
                returns the model's tool calls to you and you send the results back.

                **1. Send tools with the request:**
                ```json
                {
                  "aiConfig": [{"aiVendor": "OPENAI", "model": "gpt-5"}],
                  "prompt": {"instructionId": "", "instructionVersion": "", "prompt": "Weather in Paris?"},
                  "selectedResponseId": null, "conversationId": null, "client": "api",
                  "tools": [{
                    "name": "get_weather",
                    "description": "Get current weather for a city",
                    "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}
                  }]
                }
                ```
                `toolChoice` is optional: `"auto"` (default), `"required"`, or a tool name.

                **2. The model may answer with tool calls instead of text.**
                Non-streaming: the response's `toolCalls` field, e.g.
                `[{"id": "call_1", "name": "get_weather", "args": {"city": "Paris"}}]`.
                Streaming: a `{"t": "tc", "v": [...]}` line in the stream; the assistant
                message id is in the `X-Response-Message-Id` header.

                **3. Execute the tools yourself, then continue the turn** by sending a
                follow-up generation request with `selectedResponseId` set to the
                tool-calling message's id, the same `tools`, an empty `prompt`, and:
                ```json
                {"toolResults": [{"toolCallId": "call_1", "content": "18C, sunny"}]}
                ```
                The model then produces the final text answer. The model may also chain
                further tool calls — repeat step 3 until you receive text. Tool exchanges
                are persisted in the conversation, so later turns retain full context.

                ### Computer use (Claude only)

                Anthropic's native computer-use tool is supported by setting `type` on a
                tool definition (no `parameters` — Anthropic defines the action space):
                ```json
                {"tools": [{"name": "computer", "type": "computer_20250124",
                            "options": {"display_width_px": 1280, "display_height_px": 800}}]}
                ```
                The required beta header is applied automatically. The model responds with
                actions as tool calls (`screenshot`, `left_click`, `type`, ...); execute them
                against your environment and continue with `toolResults`. Screenshot results
                are sent as images:
                ```json
                {"toolResults": [{"toolCallId": "toolu_1", "content": "",
                                  "images": [{"data": "<base64 png>", "mediaType": "image/png"}]}]}
                ```
                Images may alternatively reference an uploaded attachment via `s3Key`.
                Native tool types and image tool results are rejected for non-Claude vendors.
                Inline screenshot data is not replayed in later conversation turns
                (marked "[screenshot omitted from history]"); S3-referenced images are.
            """.trimIndent()
        }
        security {
            securityScheme("apiKey") {
                type = AuthType.HTTP
                scheme = AuthScheme.BEARER
                description = "Developer API key (format `gfy_...`), created in the web app " +
                        "under Settings → Developer. Send as `Authorization: Bearer gfy_...`."
            }
            defaultSecuritySchemeNames("apiKey")
            defaultUnauthorizedResponse {
                description = "Missing, invalid or revoked API key"
            }
        }
        tags {
            tag("Generation") {
                description = "AI text generation, model listing and usage. Supports image " +
                        "attachments (see Attachments) and cross-vendor tool use — the " +
                        "request/continue flow is described in the API introduction above."
            }
            tag("Conversations") { description = "Conversation history, sharing and lifecycle" }
            tag("Instructions") { description = "Instruction (persona) management and sharing" }
            tag("Customer") { description = "Onboarding, profile and configuration" }
            tag("Tool Credentials") { description = "Credentials for external tools" }
            tag("Agents") { description = "Agent graph management" }
            tag("Notes") { description = "Customer notes" }
            tag("Voice") { description = "Realtime voice sessions and voice model listing" }
            tag("Attachments") {
                description = "Image attachments for AI requests. Flow: POST /attachments with the " +
                        "image's media type and size to get a presigned S3 upload URL, PUT the raw " +
                        "bytes to that URL, then include the returned attachmentId/s3Key/mediaType " +
                        "in the prompt.attachments array of a generate-text or generate-text-stream " +
                        "request. Supported types: PNG, JPEG, WebP, GIF; max 5 MB per image, " +
                        "10 images per message."
            }
        }
    }

    // Koin must start before Authentication: the apiKey provider needs DeveloperApiKeyService
    startKoin {
        modules(
            appModule(),
            commonModule()
        )
    }

    val auth0Domain = System.getenv("AUTH0_SPA_DOMAIN")
        ?: error("AUTH0_SPA_DOMAIN not set")

    val issuer = "https://$auth0Domain/"

    val jwkProvider = JwkProviderBuilder(issuer)
        .cached(10, 24, TimeUnit.HOURS)
        .rateLimited(10, 1, TimeUnit.MINUTES)
        .build()

    val developerApiKeyService = get<DeveloperApiKeyService>()

    install(Authentication) {
        jwt("auth0") {
            logger.info("jwkProvider {}", jwkProvider)
            // Browsers cannot set headers on WebSocket connections (voice
            // sessions), so fall back to an access_token query parameter.
            authHeader { call ->
                try {
                    call.request.parseAuthorizationHeader()
                } catch (_: Exception) {
                    null
                } ?: call.request.queryParameters["access_token"]?.let {
                    HttpAuthHeader.Single("Bearer", it)
                }
            }
            verifier(jwkProvider, issuer)
            validate { credential -> validateCredentials(credential) }
        }
        // Developer API keys (gfy_...) sent as a bearer token; routes opt in via
        // authenticate("auth0", "apiKey") so both JWTs and API keys are accepted
        bearer("apiKey") {
            authenticate { credential ->
                developerApiKeyService.authenticate(credential.token)
                    ?.let { customerId -> ApiKeyPrincipal(customerId) }
            }
        }
    }

    install(CORS) {
        // Allow all origins for development
        anyHost()
        
        allowMethod(HttpMethod.Options)
        allowMethod(HttpMethod.Get)
        allowMethod(HttpMethod.Post)
        allowMethod(HttpMethod.Put)
        allowMethod(HttpMethod.Delete)
        allowMethod(HttpMethod.Patch)
        
        allowHeader(HttpHeaders.ContentType)
        allowHeader(HttpHeaders.Authorization)
        allowHeader(HttpHeaders.AccessControlAllowOrigin)
        allowHeader(HttpHeaders.AccessControlAllowHeaders)
        allowHeader(HttpHeaders.AccessControlAllowMethods)
        exposeHeader("X-Conversation-Id")
        exposeHeader("X-Message-Id")
        exposeHeader("X-Response-Message-Id")
        exposeHeader("X-Ai-Vendor")
        exposeHeader("X-Input-Tokens")
        exposeHeader("X-Output-Tokens")
        
        allowCredentials = true
        allowNonSimpleContentTypes = true
        
        // For production, replace anyHost() with specific hosts:
        // allowHost("localhost:3000", schemes = listOf("http"))
        // allowHost("your-frontend-domain.com", schemes = listOf("https"))
    }


    val aiRequestService = get<AIRequestService>()
    val aiRequestManager = get<AIRequestManager>()
    val customerProfileService = get<CustomerProfileService>()
    val conversationService = get<ConversationService>()
    val aiModelsService = get<AIModelsService>()
    val graphService = get<GraphService>()
    val dynamoDBProvider = get<com.genflowly.providers.DynamoDBProvider>()
    val s3Provider = get<com.genflowly.providers.S3Provider>()
    val notesService = get<NotesService>()

    val httpClient = get<io.ktor.client.HttpClient>()
    val json = get<kotlinx.serialization.json.Json>()

    configureRouting(aiRequestService, aiRequestManager, customerProfileService, conversationService, aiModelsService, graphService, dynamoDBProvider, s3Provider, notesService, developerApiKeyService, httpClient, json)
}
