package com.genflowly.activity.attachment

import com.genflowly.Routes
import com.genflowly.models.api.CreateAttachmentUploadRequest
import com.genflowly.models.api.CreateAttachmentUploadResponse
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.GetAttachmentUrlResponse
import com.genflowly.service.AttachmentService
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.get
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.plugins.BadRequestException
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.SerializationException
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("AttachmentRoutes")

fun Route.registerAttachmentRoutes(
    attachmentService: AttachmentService,
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0", "apiKey") {
        post(Routes.CREATE_ATTACHMENT, {
            tags("Attachments")
            summary = "Request a presigned URL to upload an attachment"
            description = "Returns a short-lived presigned S3 PUT URL for an image of any type and " +
                    "size (e.g. HEIC photos straight from an iPhone) or a PDF of at most 10 MB. " +
                    "The declared media type is normalized — parameters are dropped, and blank, " +
                    "malformed, scriptable (SVG) or other non-image values except application/pdf " +
                    "become application/octet-stream — and returned as mediaType. Upload the raw " +
                    "bytes to uploadUrl with Content-Type set to exactly that returned mediaType and " +
                    "with every requiredHeaders entry (e.g. x-amz-tagging; they are part of the " +
                    "signature), then reference the returned attachmentId/s3Key/mediaType and " +
                    "fileName (as filename) in a generate-text request. Send tagging=true: the upload " +
                    "is then tagged to expire unless a message links it (PDFs always are). The real " +
                    "image format is detected from the bytes at generation time and " +
                    "converted/compressed to fit each AI vendor's limits (losslessly where possible); " +
                    "files that cannot be decoded as an image fail the generation with a clear error. " +
                    "At most 5 PDFs per message; a server with PDF attachments switched off " +
                    "(PDF_UPLOADS_ENABLED) answers 400 for a PDF. The original upload is kept unchanged."
            request {
                body<CreateAttachmentUploadRequest> { required = true }
            }
            response {
                code(HttpStatusCode.OK) { body<CreateAttachmentUploadResponse>() }
                code(HttpStatusCode.BadRequest) {
                    description = "Malformed request body, sizeBytes below 1, a PDF over 10 MB, " +
                        "or a PDF while PDF attachments are switched off"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.Forbidden) {
                    description = "Authenticated user has no customer profile (not onboarded)"
                    body<ErrorResponse>()
                }
            }
        }) {
            try {
                val request = call.receive<CreateAttachmentUploadRequest>()
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)

                val upload = try {
                    attachmentService.createUploadUrl(
                        customerId, request.mediaType, request.sizeBytes,
                        fileName = request.fileName, tagging = request.tagging
                    )
                } catch (e: IllegalArgumentException) {
                    call.respond(HttpStatusCode.BadRequest, mapOf("error" to (e.message ?: "Invalid attachment")))
                    return@post
                }

                call.respond(
                    CreateAttachmentUploadResponse(
                        attachmentId = upload.attachmentId,
                        s3Key = upload.s3Key,
                        // Normalized type bound into the presigned PUT — the client must upload with it
                        mediaType = upload.mediaType,
                        uploadUrl = upload.uploadUrl,
                        fileName = upload.fileName,
                        // Also signed into the PUT — the client must send each one
                        requiredHeaders = upload.requiredHeaders
                    )
                )
            } catch (e: SerializationException) {
                logger.error("Malformed CreateAttachment request: {}", e.message, e)
                call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Invalid request format: ${e.message}"))
            } catch (e: BadRequestException) {
                // Ktor 3 wraps body conversion failures (bad JSON, missing sizeBytes)
                logger.warn("Malformed CreateAttachment request: {}", e.message)
                call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Invalid request format: ${e.message}"))
            } catch (e: Exception) {
                logger.error("Unexpected error creating attachment upload URL: {}", e.message, e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to "Internal server error: ${e.message}"))
            }
        }

        get(Routes.GET_ATTACHMENT_URL, {
            tags("Attachments")
            summary = "Get a presigned URL to view an attachment"
            description = "Returns a presigned S3 GET URL for an attachment, for rendering images " +
                    "and opening files when displaying a conversation. With conversationId, any " +
                    "participant of that conversation (owner, share recipient or public viewer) " +
                    "gets the file stored on its messages, whoever uploaded or generated it. " +
                    "Without it, only the authenticated customer's own attachments resolve."
            request {
                queryParameter<String>("attachmentId") {
                    description = "Attachment ID returned at upload time, or a generated file's ID"
                    required = true
                }
                queryParameter<String>("conversationId") {
                    description = "Conversation the attachment is shown in. The caller must be its " +
                            "owner or have it shared with them (public shares included), and the " +
                            "attachment must appear in one of its messages."
                    required = false
                }
            }
            response {
                code(HttpStatusCode.OK) { body<GetAttachmentUrlResponse>() }
                code(HttpStatusCode.BadRequest) {
                    description = "Missing attachmentId"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.NotFound) {
                    description = "No such attachment for the caller: not their own (without " +
                            "conversationId), or not in a conversation they can read (with it)"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.Forbidden) {
                    description = "Authenticated user has no customer profile (not onboarded)"
                    body<ErrorResponse>()
                }
            }
        }) {
            try {
                val attachmentId = call.request.queryParameters["attachmentId"]
                if (attachmentId.isNullOrBlank()) {
                    call.respond(HttpStatusCode.BadRequest, mapOf("error" to "attachmentId is required"))
                    return@get
                }
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val conversationId = call.request.queryParameters["conversationId"]?.takeIf { it.isNotBlank() }

                val url = if (conversationId != null) {
                    attachmentService.getViewUrlInConversation(customerId, attachmentId, conversationId)
                } else {
                    attachmentService.getViewUrl(customerId, attachmentId)
                }
                if (url == null) {
                    call.respond(HttpStatusCode.NotFound, mapOf("error" to "Attachment not found"))
                    return@get
                }

                call.respond(GetAttachmentUrlResponse(attachmentId = attachmentId, url = url))
            } catch (e: Exception) {
                logger.error("Unexpected error creating attachment view URL: {}", e.message, e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to "Internal server error: ${e.message}"))
            }
        }
    }
}
