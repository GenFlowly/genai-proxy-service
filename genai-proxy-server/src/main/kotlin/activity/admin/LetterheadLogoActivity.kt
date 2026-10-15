package com.genflowly.activity.admin

import com.genflowly.Routes
import com.genflowly.config.AppConfig
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.LetterheadLogoUploadRequest
import com.genflowly.models.api.LetterheadLogoUploadResponse
import com.genflowly.models.api.LetterheadLogoUrlResponse
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.LetterheadLogoService
import com.genflowly.utils.requireAdminCustomerId
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

private val logger = LoggerFactory.getLogger("LetterheadLogoActivity")

/**
 * Admin upload and preview of System agents' PDF letterhead logos (plan 6.2):
 * the admin panel's letterhead settings store the returned attachmentId as
 * tool_settings.generate_pdf.logo_attachment_id. JWT-only, allowlist-gated and
 * hidden from the public OpenAPI spec, like the other admin routes.
 */
fun Route.registerLetterheadLogoRoutes(
    letterheadLogoService: LetterheadLogoService,
    customerProfileService: CustomerProfileService,
    appConfig: AppConfig,
) {
    authenticate("auth0") {
        post(Routes.ADMIN_LETTERHEAD_LOGO, { hidden = true }) {
            try {
                val customerId = call.requireAdminCustomerId(customerProfileService, appConfig)
                val req = call.receive<LetterheadLogoUploadRequest>()
                try {
                    val upload = letterheadLogoService.createUpload(req.mediaType, req.sizeBytes)
                    logger.info("Admin {} uploading letterhead logo {}", customerId, upload.attachmentId)
                    call.respond(
                        LetterheadLogoUploadResponse(
                            attachmentId = upload.attachmentId,
                            uploadUrl = upload.uploadUrl,
                            mediaType = upload.mediaType
                        )
                    )
                } catch (e: IllegalArgumentException) {
                    call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "${e.message}"))
                }
            } catch (e: SerializationException) {
                call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "Invalid request format"))
            } catch (e: BadRequestException) {
                call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "Invalid request format"))
            } catch (e: IllegalStateException) {
                // requireAdminCustomerId already responded (403)
            } catch (e: Exception) {
                logger.error("Failed to presign a letterhead logo upload", e)
                call.respond(HttpStatusCode.InternalServerError, ErrorResponse(error = "Internal server error"))
            }
        }

        get(Routes.ADMIN_LETTERHEAD_LOGO_URL, { hidden = true }) {
            try {
                call.requireAdminCustomerId(customerProfileService, appConfig)
                val attachmentId = call.request.queryParameters["attachmentId"]
                if (attachmentId.isNullOrBlank()) {
                    call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "attachmentId is required"))
                    return@get
                }
                val url = letterheadLogoService.viewUrl(attachmentId)
                if (url == null) {
                    call.respond(HttpStatusCode.NotFound, ErrorResponse(error = "Letterhead logo not found"))
                    return@get
                }
                call.respond(LetterheadLogoUrlResponse(attachmentId = attachmentId, url = url))
            } catch (e: IllegalStateException) {
                // requireAdminCustomerId already responded (403)
            } catch (e: Exception) {
                logger.error("Failed to presign a letterhead logo preview", e)
                call.respond(HttpStatusCode.InternalServerError, ErrorResponse(error = "Internal server error"))
            }
        }
    }
}
