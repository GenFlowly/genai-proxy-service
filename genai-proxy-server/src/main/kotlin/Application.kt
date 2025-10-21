package com.genflowly


import com.auth0.jwk.JwkProviderBuilder
import com.genflowly.aicallerlib.di.commonModule
import com.genflowly.di.appModule
import com.genflowly.service.AIRequestService
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.auth.Authentication
import io.ktor.server.auth.jwt.JWTPrincipal
import io.ktor.server.auth.jwt.jwt
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.plugins.cors.routing.CORS
import java.util.concurrent.TimeUnit
import org.koin.core.context.startKoin
import org.koin.ktor.ext.get
import service.CustomerProfileService

fun main(args: Array<String>) {
    io.ktor.server.netty.EngineMain.main(args)
}

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


private fun Application.configureAuth0Security() {
    val domain = environment.config.property("auth0.domain").getString()
    val audience = environment.config.property("auth0.audience").getString()

    val jwkProvider = JwkProviderBuilder("https://$domain/")
        .cached(10, 24, TimeUnit.HOURS)
        .build()

    install(Authentication) {
        jwt("auth0") {
            verifier(jwkProvider, "https://$domain/")
            validate { credential ->
                if (credential.payload.audience.contains(audience)) {
                    JWTPrincipal(credential.payload)
                } else {
                    null
                }
            }
        }
    }
}
