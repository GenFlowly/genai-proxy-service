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
                    "size (e.g. HEIC photos straight from an iPhone). The declared media type is " +
                    "normalized — parameters are dropped and blank or malformed values become " +
                    "application/octet-stream — and returned as mediaType. Upload the raw bytes " +
                    "to uploadUrl with Content-Type set to exactly that returned mediaType (it is " +
                    "part of the signature), then reference the returned attachmentId/s3Key/" +
                    "mediaType in a generate-text request. Images are converted/compressed " +
                    "losslessly server-side to fit each AI vendor's limits; the original upload " +
                    "is kept unchanged."
            request {
                body<CreateAttachmentUploadRequest> { required = true }
            }
            response {
                code(HttpStatusCode.OK) { body<CreateAttachmentUploadResponse>() }
                code(HttpStatusCode.BadRequest) {
                    description = "Malformed request body or sizeBytes below 1"
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
                    attachmentService.createUploadUrl(customerId, request.mediaType, request.sizeBytes)
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
                        uploadUrl = upload.uploadUrl
                    )
                )
            } catch (e: SerializationException) {
                logger.error("Malformed CreateAttachment request: {}", e.message, e)
                call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Invalid request format: ${e.message}"))
            } catch (e: Exception) {
                logger.error("Unexpected error creating attachment upload URL: {}", e.message, e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to "Internal server error: ${e.message}"))
            }
        }

        get(Routes.GET_ATTACHMENT_URL, {
            tags("Attachments")
            summary = "Get a presigned URL to view an attachment"
            description = "Returns a presigned S3 GET URL for an attachment owned by the " +
                    "authenticated customer, for rendering images when displaying a conversation."
            request {
                queryParameter<String>("attachmentId") {
                    description = "Attachment ID returned at upload time"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) { body<GetAttachmentUrlResponse>() }
                code(HttpStatusCode.NotFound) {
                    description = "No attachment with this ID exists for the authenticated customer"
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

                val url = attachmentService.getViewUrl(customerId, attachmentId)
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
