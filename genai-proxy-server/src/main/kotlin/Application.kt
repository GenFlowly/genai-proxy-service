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
import io.ktor.server.auth.jwt.JWTCredential
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


fun validateCredentials(credential: JWTCredential): JWTPrincipal? {
    val auth0Audience = "https://genflowly-beta" //TODO fetch from env
    val containsAudience = credential.payload.audience.contains(auth0Audience)
    logger.info("Audience {}", credential.payload.audience)

    if (containsAudience) {
        return JWTPrincipal(credential.payload)
    }

    return null
}

fun Application.module() {
    install(ContentNegotiation) {
        json()
    }

    val issuer = "https://dev-abh5z7416lwy3xhv.us.auth0.com/" //TODO fetch
    // from env

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
        allowMethod(HttpMethod.Options)
        allowMethod(HttpMethod.Get)
        allowMethod(HttpMethod.Post)
        allowHeader(HttpHeaders.ContentType)
        allowHeader(HttpHeaders.Authorization)
        allowCredentials = true
        allowNonSimpleContentTypes = true

        // 👇 Adjust for your frontend origins
        allowHost("localhost:3000", schemes = listOf("http"))
        // allowHost("your-frontend-domain.com", schemes = listOf("https"))
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



