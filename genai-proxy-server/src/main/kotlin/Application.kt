package com.genflowly


import com.auth0.jwk.JwkProviderBuilder
import com.genflowly.aicallerlib.di.commonModule
import com.genflowly.di.appModule
import com.genflowly.service.AIRequestService
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
import com.genflowly.service.GraphService
import com.genflowly.service.NotesService


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

    val auth0Domain = System.getenv("AUTH0_SPA_DOMAIN")
        ?: error("AUTH0_SPA_DOMAIN not set")

    val issuer = "https://$auth0Domain/"

    val jwkProvider = JwkProviderBuilder(issuer)
        .cached(10, 24, TimeUnit.HOURS)
        .rateLimited(10, 1, TimeUnit.MINUTES)
        .build()

    install(Authentication) {
        jwt("auth0") {
            logger.info("jwkProvider {}", jwkProvider)
            verifier(jwkProvider, issuer)
            validate { credential -> validateCredentials(credential) }
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


    startKoin {
        modules(
            appModule(),
            commonModule()
        )
    }



    val aiRequestService = get<AIRequestService>()
    val aiRequestManager = get<AIRequestManager>()
    val customerProfileService = get<CustomerProfileService>()
    val conversationService = get<ConversationService>()
    val aiModelsService = get<AIModelsService>()
    val graphService = get<GraphService>()
    val dynamoDBProvider = get<com.genflowly.providers.DynamoDBProvider>()
    val notesService = get<NotesService>()

    configureRouting(aiRequestService, aiRequestManager, customerProfileService, conversationService, aiModelsService, graphService, dynamoDBProvider, notesService)
}
