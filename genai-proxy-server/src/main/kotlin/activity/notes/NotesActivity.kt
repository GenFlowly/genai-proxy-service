package com.genflowly.activity.notes

import com.genflowly.Routes
import com.genflowly.models.api.ErrorResponse
import com.genflowly.service.GetNotesResponse
import com.genflowly.service.NotesService
import com.genflowly.service.SaveNoteRequest
import com.genflowly.service.SaveNoteResponse
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.get
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.auth.authenticate
import io.ktor.server.auth.jwt.JWTPrincipal
import io.ktor.server.auth.principal
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("NotesActivity")

fun Route.registerNotesRoutes(
    notesService: NotesService,
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0") {
        get("/api/v1/notes", {
            tags("Notes")
            summary = "List the customer's notes"
            description = "Web-app only: requires an Auth0 JWT; not accessible with a developer API key."
            response {
                code(HttpStatusCode.OK) {
                    description = "The customer's notes"
                    body<GetNotesResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                    body<ErrorResponse>()
                }
            }
        }) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)

                val response = notesService.getNotes(customerId)
                call.respond(HttpStatusCode.OK, response)
            } catch (e: Exception) {
                logger.error("Error fetching notes", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to "Failed to fetch notes"))
            }
        }

        post("/api/v1/notes", {
            tags("Notes")
            summary = "Save a note"
            description = "Saves a note asynchronously and returns its (possibly AI-generated) title. " +
                    "Web-app only: requires an Auth0 JWT; not accessible with a developer API key."
            request {
                body<SaveNoteRequest> {
                    description = "Note content to save"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Note accepted for saving"
                    body<SaveNoteResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                    body<ErrorResponse>()
                }
            }
        }) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                
                val token = call.request.headers["Authorization"]?.removePrefix("Bearer ")?.trim()
                if (token == null) {
                    call.respond(HttpStatusCode.Unauthorized, mapOf("error" to "Missing authentication token"))
                    return@post
                }

                val request = call.receive<SaveNoteRequest>()
                val title = notesService.saveNoteAsync(customerId, request, token)

                call.respond(HttpStatusCode.OK, SaveNoteResponse(status = "success", title = title))
            } catch (e: Exception) {
                logger.error("Error saving note", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to "Failed to save note"))
            }
        }
    }
}
