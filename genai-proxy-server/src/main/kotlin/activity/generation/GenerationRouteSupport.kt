package com.genflowly.activity.generation

import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.response.respond
import com.genflowly.service.RequestValidationException
import kotlinx.serialization.SerializationException
import org.slf4j.Logger

/**
 * Shared error handling for the generation routes: malformed request
 * bodies and requests the validator refuses (too many or too large PDFs,
 * foreign keys, ...) become 400s, anything else a 500. Inline so a
 * non-local `return@post` inside [block] still exits the route handler.
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
    } catch (e: RequestValidationException) {
        logger.warn("Refused {} request: {}", routeName, e.message)
        respond(HttpStatusCode.BadRequest, mapOf("error" to e.message))
    } catch (e: Exception) {
        logger.error("Unexpected error in {} controller: {}", routeName, e.message, e)
        respond(
            HttpStatusCode.InternalServerError,
            mapOf("error" to "Internal server error: ${e.message}")
        )
    }
}
