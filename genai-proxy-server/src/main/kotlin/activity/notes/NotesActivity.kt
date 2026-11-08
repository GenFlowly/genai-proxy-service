package com.genflowly.activity.notes

import com.genflowly.Routes
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.DeleteNoteResponse
import com.genflowly.models.api.GetNotesResponse
import com.genflowly.service.NoteNotFoundException
import com.genflowly.service.NotesService
import com.genflowly.models.api.SaveNoteRequest
import com.genflowly.models.api.SaveNoteResponse
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.bearerToken
import com.genflowly.utils.ensureAiDataConsent
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.delete
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
                if (!call.ensureAiDataConsent(customerProfileService)) return@post
                
                val token = call.bearerToken()
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

        delete("/api/v1/notes/{noteKey}", {
            tags("Notes")
            summary = "Delete a note"
            description = "Permanently deletes the note: its row, its batch-mode document and its vectors. " +
                    "It can't be restored. " +
                    "Web-app only: requires an Auth0 JWT; not accessible with a developer API key."
            request {
                pathParameter<String>("noteKey") {
                    description = "Note to delete"
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Note deleted"
                    body<DeleteNoteResponse>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "Missing noteKey"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.NotFound) {
                    description = "Note does not exist"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                    body<ErrorResponse>()
                }
            }
        }) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val noteKey = call.parameters["noteKey"]

                if (noteKey.isNullOrBlank()) {
                    return@delete call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Missing noteKey"))
                }

                notesService.deleteNote(customerId, noteKey)
                call.respond(HttpStatusCode.OK, DeleteNoteResponse(status = "success"))
            } catch (e: NoteNotFoundException) {
                call.respond(HttpStatusCode.NotFound, mapOf("error" to "Note not found"))
            } catch (e: Exception) {
                logger.error("Error deleting note", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to "Failed to delete note"))
            }
        }
    }
}
