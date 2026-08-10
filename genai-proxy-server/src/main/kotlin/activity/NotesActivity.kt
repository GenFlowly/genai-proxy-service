package com.genflowly.activity

import com.genflowly.Routes
import com.genflowly.service.NotesService
import com.genflowly.service.SaveNoteRequest
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.auth.authenticate
import io.ktor.server.auth.jwt.JWTPrincipal
import io.ktor.server.auth.principal
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.post
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("NotesActivity")

fun Route.registerSaveNotesRoutes(notesService: NotesService) {
    authenticate("auth0") {
        post("/api/v1/notes") {
            try {
                val principal = call.principal<JWTPrincipal>()
                val customerId = principal?.payload?.getClaim("https://genflowly.com/customerId")?.asString()
                if (customerId == null) {
                    call.respond(HttpStatusCode.Unauthorized, "Missing customer ID")
                    return@post
                }

                val request = call.receive<SaveNoteRequest>()
                notesService.saveNoteAsync(customerId, request)

                call.respond(HttpStatusCode.OK, mapOf("status" to "success"))
            } catch (e: Exception) {
                logger.error("Error saving note", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to "Failed to save note"))
            }
        }
    }
}
