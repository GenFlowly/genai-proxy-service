package com.genflowly.activity.generation

import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.response.respond
import kotlinx.serialization.SerializationException
import org.slf4j.Logger

/**
 * Shared error handling for the generation routes: malformed request bodies and
 * request-validation failures (IllegalArgumentException from the generation
 * validator — too many/oversize PDFs, wrong type, unowned/unuploaded
 * attachment, mutually-exclusive options) become 400s; anything else a 500.
 * Inline so a non-local `return@post` inside [block] still exits the route
 * handler.
 */
suspend inline fun ApplicationCall.handleGenerationErrors(
    logger: Logger,
    routeName: String,
    block: () -> Unit
) {
    try {
        block()
    } catch (e: SerializationException) {
        logger.error("Malformed {} request: {}", routeName, e.message, e)
        respond(
            HttpStatusCode.BadRequest,
            mapOf("error" to "Invalid request format: ${e.message}")
        )
    } catch (e: IllegalArgumentException) {
        // A request the generation validator refused is the caller's mistake,
        // not a server fault — surface the client-facing message as a 400.
        logger.warn("Rejected {} request: {}", routeName, e.message)
        respond(
            HttpStatusCode.BadRequest,
            mapOf("error" to (e.message ?: "Invalid request"))
        )
    } catch (e: Exception) {
        logger.error("Unexpected error in {} controller: {}", routeName, e.message, e)
        respond(
            HttpStatusCode.InternalServerError,
            mapOf("error" to "Internal server error: ${e.message}")
        )
    }
}
