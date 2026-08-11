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

    install(OpenApi) {
        info {
            title = "GenAI Proxy Service API"
            version = "1.0.0"
            description = """
                REST API for the GenAI proxy service: AI text generation across vendors,
                conversation and instruction management, customer onboarding and configuration.

                Authenticate with a developer API key, created in the web app under
                Settings → Developer. Pass it on every request as
                `Authorization: Bearer gfy_...`. Keys are shown once at creation and can be
                revoked at any time from the same page. A few web-app-only endpoints
                (onboarding, profile, user search, notes) additionally require an Auth0 session
                and are marked as such in their descriptions.
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
            tag("Generation") { description = "AI text generation, model listing and usage" }
            tag("Conversations") { description = "Conversation history, sharing and lifecycle" }
            tag("Instructions") { description = "Instruction (persona) management and sharing" }
            tag("Customer") { description = "Onboarding, profile and configuration" }
            tag("Tool Credentials") { description = "Credentials for external tools" }
            tag("Agents") { description = "Agent graph management" }
            tag("Notes") { description = "Customer notes" }
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
    val notesService = get<NotesService>()

    configureRouting(aiRequestService, aiRequestManager, customerProfileService, conversationService, aiModelsService, graphService, dynamoDBProvider, notesService, developerApiKeyService)
}
