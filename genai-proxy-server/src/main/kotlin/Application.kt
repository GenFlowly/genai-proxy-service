package com.genflowly


import com.auth0.jwk.JwkProviderBuilder
import com.genflowly.aicallerlib.di.commonModule
import com.genflowly.di.appModule
import com.genflowly.service.AIRequestService
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.auth.Authentication
import io.ktor.server.auth.jwt.JWTPrincipal
import io.ktor.server.auth.jwt.jwt
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.plugins.cors.routing.CORS
import io.ktor.server.response.respondText
import java.util.concurrent.TimeUnit
import org.koin.core.context.startKoin
import org.koin.ktor.ext.get
import org.slf4j.LoggerFactory
import service.CustomerProfileService

fun main(args: Array<String>) {
    io.ktor.server.netty.EngineMain.main(args)
}

private val logger = LoggerFactory.getLogger("Application")

fun Application.module() {
    install(ContentNegotiation) {
        json()
    }

    install(CORS) {
        allowMethod(HttpMethod.Options)
        allowMethod(HttpMethod.Get)
        allowMethod(HttpMethod.Post)
        allowHeader(HttpHeaders.ContentType)
        allowHeader(HttpHeaders.Authorization)
        allowCredentials = true

        // 👇 Adjust for your frontend origins
        allowHost("localhost:3000", schemes = listOf("http"))
        allowHost("your-frontend-domain.com", schemes = listOf("https"))
    }

    install(Authentication) {
        jwt("auth0") {
            val auth0Domain = "dev-abh5z7416lwy3xhv.us.auth0.com"

            val auth0Audience = "https://beta-genflowly/api"

            logger.info("🔐 Configuring Auth0 JWT with domain: $auth0Domain, audience: $auth0Audience")

            val jwkProvider = JwkProviderBuilder(auth0Domain)
                .cached(10, 24, TimeUnit.HOURS)
                .rateLimited(10, 1, TimeUnit.MINUTES)
                .build()

            verifier(jwkProvider, auth0Audience)

            validate { credential ->
                try {
                    logger.info("✅ JWT Token validation starting")
                    logger.info("Token claims: ${credential.payload.claims}")
                    logger.info("Token audience: ${credential.payload.audience}")
                    logger.info("Token issuer: ${credential.payload.issuer}")

                    // Check if audience contains our expected audience
                    val tokenAudience = credential.payload.audience
                    val hasValidAudience = tokenAudience?.contains(auth0Audience) == true

                    if (!hasValidAudience) {
                        logger.error("❌ Invalid audience. Expected: $auth0Audience, Got: $tokenAudience")
                        return@validate null
                    }

                    logger.info("✅ Audience validation passed")
                    JWTPrincipal(credential.payload)
                } catch (e: Exception) {
                    logger.error("❌ JWT validation failed: ${e.message}", e)
                    null
                }
            }


            challenge { defaultScheme, realm ->
                logger.warn("⚠️ JWT Challenge triggered - token missing or invalid")
                call.respondText(
                    """{"error": "Invalid or missing token"}""",
                    io.ktor.http.ContentType.Application.Json,
                    HttpStatusCode.Unauthorized
                )
            }
        }
    }


    startKoin {
        modules(
            appModule(),
            commonModule()
        )
    }


    val aiRequestService = get<AIRequestService>()
    val customerProfileService = get<CustomerProfileService>()

    configureRouting(aiRequestService, customerProfileService)
}



