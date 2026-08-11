package com.genflowly.activity.notes

import com.genflowly.Routes
import com.genflowly.service.NotesService
import com.genflowly.service.SaveNoteRequest
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.auth.authenticate
import io.ktor.server.auth.jwt.JWTPrincipal
import io.ktor.server.auth.principal
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("NotesActivity")

fun Route.registerNotesRoutes(
    notesService: NotesService,
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0") {
        get("/api/v1/notes") {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)

                val response = notesService.getNotes(customerId)
                call.respond(HttpStatusCode.OK, response)
            } catch (e: Exception) {
                logger.error("Error fetching notes", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to "Failed to fetch notes"))
            }
        }

        post("/api/v1/notes") {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                
                val token = call.request.headers["Authorization"]?.removePrefix("Bearer ")?.trim()
                if (token == null) {
                    call.respond(HttpStatusCode.Unauthorized, mapOf("error" to "Missing authentication token"))
                    return@post
                }

                val request = call.receive<SaveNoteRequest>()
                notesService.saveNoteAsync(customerId, request, token)

                call.respond(HttpStatusCode.OK, mapOf("status" to "success"))
            } catch (e: Exception) {
                logger.error("Error saving note", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to "Failed to save note"))
            }
        }
    }
}
