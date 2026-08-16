package com.genflowly.activity.attachment

import com.genflowly.Routes
import com.genflowly.models.api.CreateAttachmentUploadRequest
import com.genflowly.models.api.CreateAttachmentUploadResponse
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.GetAttachmentUrlResponse
import com.genflowly.providers.S3Provider
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.get
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import java.util.UUID
import kotlinx.serialization.SerializationException
import models.ALLOWED_ATTACHMENT_MEDIA_TYPES
import models.MAX_ATTACHMENT_SIZE_BYTES
import models.attachmentS3Key
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("AttachmentRoutes")

fun Route.registerAttachmentRoutes(
    s3Provider: S3Provider,
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0", "apiKey") {
        post(Routes.CREATE_ATTACHMENT, {
            tags("Attachments")
            summary = "Request a presigned URL to upload an image attachment"
            description = "Validates the declared media type and size, then returns a short-lived " +
                    "presigned S3 PUT URL. Upload the raw image bytes to that URL with " +
                    "Content-Type set to the declared media type, then reference the returned " +
                    "attachmentId/s3Key in a generate-text request."
            request {
                body<CreateAttachmentUploadRequest> { required = true }
            }
            response {
                code(HttpStatusCode.OK) { body<CreateAttachmentUploadResponse>() }
                code(HttpStatusCode.BadRequest) {
                    description = "Unsupported media type or size over the 5 MB limit"
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

                if (request.mediaType !in ALLOWED_ATTACHMENT_MEDIA_TYPES) {
                    call.respond(
                        HttpStatusCode.BadRequest,
                        mapOf("error" to "Unsupported media type '${request.mediaType}'. Allowed: $ALLOWED_ATTACHMENT_MEDIA_TYPES")
                    )
                    return@post
                }
                if (request.sizeBytes <= 0 || request.sizeBytes > MAX_ATTACHMENT_SIZE_BYTES) {
                    call.respond(
                        HttpStatusCode.BadRequest,
                        mapOf("error" to "Attachment size must be between 1 byte and $MAX_ATTACHMENT_SIZE_BYTES bytes")
                    )
                    return@post
                }

                val attachmentId = UUID.randomUUID().toString()
                val s3Key = attachmentS3Key(customerId, attachmentId)
                val uploadUrl = s3Provider.presignPut(s3Key, request.mediaType)

                logger.info(
                    "Presigned attachment upload for customer {}: id={} mediaType={} sizeBytes={}",
                    customerId, attachmentId, request.mediaType, request.sizeBytes
                )

                call.respond(
                    CreateAttachmentUploadResponse(
                        attachmentId = attachmentId,
                        s3Key = s3Key,
                        mediaType = request.mediaType,
                        uploadUrl = uploadUrl
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
                pathParameter<String>("attachmentId") { description = "Attachment ID returned at upload time" }
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
                val attachmentId = call.parameters["attachmentId"]
                if (attachmentId.isNullOrBlank()) {
                    call.respond(HttpStatusCode.BadRequest, mapOf("error" to "attachmentId is required"))
                    return@get
                }
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)

                // The key embeds the authenticated customerId, so a customer can only
                // ever address their own objects — no cross-customer lookup possible.
                val s3Key = attachmentS3Key(customerId, attachmentId)
                if (s3Provider.head(s3Key) == null) {
                    call.respond(HttpStatusCode.NotFound, mapOf("error" to "Attachment not found"))
                    return@get
                }

                call.respond(GetAttachmentUrlResponse(attachmentId = attachmentId, url = s3Provider.presignGet(s3Key)))
            } catch (e: Exception) {
                logger.error("Unexpected error creating attachment view URL: {}", e.message, e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to "Internal server error: ${e.message}"))
            }
        }
    }
}
