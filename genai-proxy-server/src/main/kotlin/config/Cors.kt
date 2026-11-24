package com.genflowly.config

import com.genflowly.ResponseHeaders
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationCallPipeline
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.plugins.cors.routing.CORS
import io.ktor.server.request.header
import io.ktor.server.request.httpMethod
import io.ktor.server.request.path
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

// The request headers our own clients send.
private val listedRequestHeaders = listOf(
    HttpHeaders.ContentType,
    HttpHeaders.Authorization,
    HttpHeaders.AccessControlAllowOrigin,
    HttpHeaders.AccessControlAllowHeaders,
    HttpHeaders.AccessControlAllowMethods,
)
private val listedRequestHeadersLowercase = listedRequestHeaders.map { it.lowercase() }.toSet()

fun Application.configureCors() {
    // Name any unlisted header a preflight asks for. It was added outside our
    // clients, and production keeps no other record of what added it.
    // Registered before CORS so it runs before the preflight is answered.
    intercept(ApplicationCallPipeline.Plugins) {
        val requested = call.request.header(HttpHeaders.AccessControlRequestHeaders)
        if (call.request.httpMethod == HttpMethod.Options && requested != null) {
            val unlisted = requested.split(',')
                .map { it.trim().lowercase() }
                .filter { it.isNotEmpty() && it !in listedRequestHeadersLowercase }
            if (unlisted.isNotEmpty()) {
                logger.warn {
                    "CORS preflight for ${call.request.path()} from ${call.request.header(HttpHeaders.Origin)} " +
                        "asks for unlisted request headers $unlisted — allowed"
                }
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

        listedRequestHeaders.forEach { allowHeader(it) }
        // The web app calls api.genflowly.com cross-origin, so each call waits
        // on a preflight, and a browser extension or security agent can add a
        // header of its own. Refusing that header 403'd the preflight, and the
        // browser dropped the call: the session's sidebar, models and agents
        // stayed empty. The API authenticates with a bearer token, so an extra
        // header gets a caller nothing.
        allowHeaders { true }
        exposeHeader(ResponseHeaders.CONVERSATION_ID)
        exposeHeader(ResponseHeaders.MESSAGE_ID)
        exposeHeader(ResponseHeaders.RESPONSE_MESSAGE_ID)
        exposeHeader(ResponseHeaders.AI_VENDOR)
        exposeHeader(ResponseHeaders.INSTRUCTION_ID)
        exposeHeader(ResponseHeaders.INSTRUCTION_VERSION)

        allowCredentials = true
        allowNonSimpleContentTypes = true

        // For production, replace anyHost() with specific hosts:
        // allowHost("localhost:3000", schemes = listOf("http"))
        // allowHost("your-frontend-domain.com", schemes = listOf("https"))
    }
}
