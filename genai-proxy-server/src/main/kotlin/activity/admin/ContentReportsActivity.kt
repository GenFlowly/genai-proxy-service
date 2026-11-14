package com.genflowly.activity.admin

import com.genflowly.Routes
import com.genflowly.config.AppConfig
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.ReportStatus
import com.genflowly.models.api.ResolveContentReportRequest
import com.genflowly.models.api.StatusResponse
import com.genflowly.service.ContentReportService
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.ReportAlreadyResolvedException
import com.genflowly.service.ReportNotFoundException
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

private val logger = LoggerFactory.getLogger("ContentReportsActivity")
private const val DEFAULT_PAGE_SIZE = 25

/** The admin panel's Reports page. JWT-only, allowlist-gated and hidden from the public OpenAPI spec. */
fun Route.registerContentReportsAdminRoutes(
    contentReportService: ContentReportService,
    customerProfileService: CustomerProfileService,
    appConfig: AppConfig
) {
    authenticate("auth0") {
        get(Routes.ADMIN_REPORTS, { hidden = true }) {
            try {
                call.requireAdminCustomerId(customerProfileService, appConfig)
                val status = call.request.queryParameters["status"]
                    ?.let { runCatching { ReportStatus.valueOf(it) }.getOrNull() }
                    ?: ReportStatus.OPEN
                val limit = call.request.queryParameters["limit"]?.toIntOrNull() ?: DEFAULT_PAGE_SIZE
                call.respond(contentReportService.listReports(status, limit, call.request.queryParameters["cursor"]))
            } catch (e: IllegalArgumentException) {
                call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = e.message ?: "Invalid request"))
            } catch (e: IllegalStateException) {
                // requireAdminCustomerId already responded (403)
            } catch (e: Exception) {
                logger.error("Failed to list content reports", e)
                call.respond(HttpStatusCode.InternalServerError, ErrorResponse(error = "Internal server error"))
            }
        }

        post(Routes.ADMIN_REPORT, { hidden = true }) {
            try {
                val adminId = call.requireAdminCustomerId(customerProfileService, appConfig)
                val entityId = call.parameters["entityId"].orEmpty()
                val reporter = call.parameters["reporterCustomerId"].orEmpty()
                val request = call.receive<ResolveContentReportRequest>()
                contentReportService.resolveReport(adminId, entityId, reporter, request)
                call.respond(StatusResponse("success"))
            } catch (e: ReportNotFoundException) {
                call.respond(HttpStatusCode.NotFound, ErrorResponse(error = e.message.orEmpty()))
            } catch (e: ReportAlreadyResolvedException) {
                call.respond(HttpStatusCode.Conflict, ErrorResponse(error = e.message.orEmpty()))
            } catch (e: SerializationException) {
                call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "Invalid request format"))
            } catch (e: BadRequestException) {
                call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "Invalid request format"))
            } catch (e: IllegalStateException) {
                // requireAdminCustomerId already responded (403)
            } catch (e: Exception) {
                logger.error("Failed to resolve a content report", e)
                call.respond(HttpStatusCode.InternalServerError, ErrorResponse(error = "Internal server error"))
            }
        }
    }
}
