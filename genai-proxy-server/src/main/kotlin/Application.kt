package com.genflowly


import com.auth0.jwk.JwkProviderBuilder
import com.genflowly.aicallerlib.di.commonModule
import com.genflowly.di.AppScope
import com.genflowly.di.appModule
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
import com.genflowly.service.CustomerCredentialsService
import com.genflowly.service.GenerationOrchestrator
import com.genflowly.service.InstructionService
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.AIModelsService
import com.genflowly.models.ApiKeyPrincipal
import com.genflowly.service.DeveloperApiKeyService
import com.genflowly.service.GraphService
import com.genflowly.service.NotesService
import io.ktor.server.auth.bearer


fun main(args: Array<String>) {
    io.ktor.server.netty.EngineMain.main(args)
}

private val logger = LoggerFactory.getLogger("Application")


fun validateCredentials(credential: JWTCredential, auth0Audience: String): JWTPrincipal? {
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

                Anthropic's native computer-use tool lets Claude drive a screen your client
                controls: Claude looks at screenshots and responds with actions (click, type,
                scroll). Your client executes each action against its surface — a backend
                browser (Playwright/Puppeteer), an embedded iframe it can rasterize, or a VM —
                and returns a fresh screenshot. Requires a Claude `aiConfig`; native tool
                types are rejected for other vendors.

                **Step 1 — open the loop.** Set `type` on the tool (no `parameters` —
                Anthropic defines the action space). The required beta header is applied
                automatically. `display_*` must match the pixel size of the screenshots
                you will send; `agentic: false` skips retrieval for pure GUI-driving turns.
                ```json
                {
                  "aiConfig": [{"aiVendor": "CLAUDE", "model": "claude-sonnet-4-6"}],
                  "prompt": {"instructionId": "", "instructionVersion": "", "prompt": "Open example.com and add the first product to the cart"},
                  "selectedResponseId": null, "conversationId": null, "client": "my-app",
                  "agentic": false,
                  "tools": [{"name": "computer", "type": "computer_20250124",
                             "options": {"display_width_px": 1280, "display_height_px": 800}}]
                }
                ```

                **Step 2 — read the action.** The response `text` may be empty; the action
                arrives in `toolCalls` (streaming: a `{"t":"tc"}` event + the
                `X-Response-Message-Id` header):
                ```json
                {"results": [{"messageId": "8f2c...", "conversationId": "conv-123", "text": "",
                              "toolCalls": [{"id": "toolu_01A", "name": "computer", "args": {"action": "screenshot"}}]}]}
                ```
                Actions to implement: `screenshot`; `left_click` / `double_click` /
                `right_click` (`coordinate: [x, y]`); `type` (`text`); `key` (`text`,
                e.g. "Return", "ctrl+s"); `scroll` (`coordinate`, `scroll_direction`,
                `scroll_amount`); plus `mouse_move`, `left_click_drag`, `wait`,
                `cursor_position`.

                **Step 3 — execute and continue.** Same endpoint, empty prompt,
                `selectedResponseId` = the tool-calling message id, the same `tools`
                array re-declared, and the result. For a screenshot action the result
                is the image; for click/type send `content` only ("clicked") — Claude
                usually requests a fresh screenshot next to verify. The screenshot can
                be sent two ways.

                *Option A — inline base64* (simplest; each screenshot rides in the
                request body):
                ```json
                {
                  "aiConfig": [{"aiVendor": "CLAUDE", "model": "claude-sonnet-4-6"}],
                  "prompt": {"instructionId": "", "instructionVersion": "", "prompt": ""},
                  "conversationId": "conv-123", "selectedResponseId": "8f2c...", "client": "my-app",
                  "agentic": false,
                  "tools": [{"name": "computer", "type": "computer_20250124",
                             "options": {"display_width_px": 1280, "display_height_px": 800}}],
                  "toolResults": [{"toolCallId": "toolu_01A", "content": "",
                                   "images": [{"data": "<base64 PNG>", "mediaType": "image/png"}]}]
                }
                ```

                *Option B — S3 reference* (smaller request bodies; screenshots stay
                visible in later conversation turns). First upload the PNG via the
                Attachments flow — `POST /attachments` returns a presigned URL and an
                `s3Key`, `PUT` the raw bytes to the URL — then reference the key:
                ```json
                {
                  "aiConfig": [{"aiVendor": "CLAUDE", "model": "claude-sonnet-4-6"}],
                  "prompt": {"instructionId": "", "instructionVersion": "", "prompt": ""},
                  "conversationId": "conv-123", "selectedResponseId": "8f2c...", "client": "my-app",
                  "agentic": false,
                  "tools": [{"name": "computer", "type": "computer_20250124",
                             "options": {"display_width_px": 1280, "display_height_px": 800}}],
                  "toolResults": [{"toolCallId": "toolu_01A", "content": "",
                                   "images": [{"s3Key": "customers/<customerId>/attachments/<attachmentId>", "mediaType": "image/png"}]}]
                }
                ```
                The `s3Key` must come from your own attachment upload — keys outside
                the authenticated customer's space are rejected.

                **Step 4 — repeat until text.** Each response either carries `toolCalls`
                (back to step 3) or a final `text` answer (done). Cap iterations client-side
                (e.g. 25) so a confused model cannot loop forever.

                Reference client loop:
                ```js
                let convId = null, lastMsgId = null, toolResults = [];
                while (true) {
                  const res = await generateText({ prompt: toolResults.length ? "" : task,
                    conversationId: convId, selectedResponseId: lastMsgId,
                    tools: COMPUTER_TOOL, toolResults });
                  const r = res.results[0];
                  convId = r.conversationId; lastMsgId = r.messageId;
                  if (!r.toolCalls || !r.toolCalls.length) return r.text;   // done
                  toolResults = [];
                  for (const call of r.toolCalls) {
                    const out = await executeOnSurface(call.args);          // your driver
                    toolResults.push(out.screenshot
                      ? { toolCallId: call.id, content: "", images: [{ data: out.screenshot, mediaType: "image/png" }] }
                      : { toolCallId: call.id, content: out.status || "" });
                  }
                }
                ```

                Choosing between the two: inline base64 screenshots are not persisted in
                conversation history — on later turns they replay as
                "[screenshot omitted from history]", so past screenshots are invisible to
                the model. S3-referenced screenshots keep their reference and replay as
                real images. If both `data` and `s3Key` are set on one image, `data` is
                used for the current call.
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
                        "request. The s3Key is also accepted in toolResults[].images to send " +
                        "computer-use screenshots by reference (see the API introduction). " +
                        "Supported types: PNG, JPEG, WebP, GIF; max 5 MB per image, " +
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

    val auth0Config = get<com.genflowly.config.AppConfig>()
    val auth0Domain = auth0Config.auth0Domain ?: error("AUTH0_SPA_DOMAIN not set")
    val auth0Audience = auth0Config.auth0Audience ?: error("AUTH0_API_AUDIENCE not set")

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
            validate { credential -> validateCredentials(credential, auth0Audience) }
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


    // Cancel supervised background work (embedding sync, backfills, usage
    // tracking) when the server stops.
    val appScope = get<AppScope>()
    monitor.subscribe(ApplicationStopping) { appScope.shutdown() }

    val generationOrchestrator = get<GenerationOrchestrator>()
    val customerCredentialsService = get<CustomerCredentialsService>()
    val instructionService = get<InstructionService>()
    val customerProfileService = get<CustomerProfileService>()
    val conversationService = get<ConversationService>()
    val conversationManagementService = get<com.genflowly.service.ConversationManagementService>()
    val aiModelsService = get<AIModelsService>()
    val graphService = get<GraphService>()
    val attachmentService = get<com.genflowly.service.AttachmentService>()
    val voiceSessionService = get<com.genflowly.service.VoiceSessionService>()
    val appConfig = get<com.genflowly.config.AppConfig>()
    val notesService = get<NotesService>()


    val systemApiKeyService = get<com.genflowly.service.SystemApiKeyService>()

    // Refresh the AIModelCatalog table (per-model token limits, fetched from the
    // vendors with the system API keys) once at startup, then every 24 hours.
    val modelCatalogService = get<com.genflowly.service.ModelCatalogService>()
    modelCatalogService.startDailyRefresh(this)

    configureRouting(generationOrchestrator, customerProfileService, customerCredentialsService, instructionService, conversationService, conversationManagementService, aiModelsService, graphService, attachmentService, voiceSessionService, notesService, developerApiKeyService, systemApiKeyService, modelCatalogService, appConfig)
}
