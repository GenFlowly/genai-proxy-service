package com.genflowly.activity.moderation

import com.genflowly.Routes
import com.genflowly.models.api.CreateBlockRequest
import com.genflowly.models.api.CreateContentReportRequest
import com.genflowly.models.api.CreateContentReportResponse
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.ReportedEntityType
import com.genflowly.models.api.StatusResponse
import com.genflowly.service.BlockService
import com.genflowly.service.BlockTargetNotFoundException
import com.genflowly.service.ContentReportService
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.ReportNotAllowedException
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.delete
import io.github.smiley4.ktoropenapi.get
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.auth.authenticate
import io.ktor.server.plugins.BadRequestException
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.SerializationException
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("ModerationActivity")

/** Report and Block for people using the apps. JWT-only and left out of the public API docs. */
fun Route.registerModerationRoutes(
    contentReportService: ContentReportService,
    blockService: BlockService,
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0") {
        post(Routes.REPORTS, { hidden = true }) {
            call.handleModerationErrors("create report") {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val request = call.receive<CreateContentReportRequest>()
                val created = contentReportService.createReport(customerId, request)
                call.respond(CreateContentReportResponse(created))
            }
        }

        get(Routes.SHARED_ITEM_OWNER, { hidden = true }) {
            call.handleModerationErrors("get shared item owner") {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val entityId = call.request.queryParameters["entityId"]
                val entityType = call.request.queryParameters["entityType"]
                    ?.let { runCatching { ReportedEntityType.valueOf(it) }.getOrNull() }
                if (entityId.isNullOrBlank() || entityType == null) {
                    return@handleModerationErrors call.respond(
                        HttpStatusCode.BadRequest, ErrorResponse(error = "Missing entityId or entityType")
                    )
                }
                call.respond(contentReportService.ownerOfSharedItem(customerId, entityType, entityId))
            }
        }

        get(Routes.BLOCKS, { hidden = true }) {
            call.handleModerationErrors("list blocks") {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                call.respond(blockService.blockedUsers(customerId))
            }
        }

        post(Routes.BLOCKS, { hidden = true }) {
            call.handleModerationErrors("create block") {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val request = call.receive<CreateBlockRequest>()
                blockService.block(customerId, request.customerId)
                call.respond(StatusResponse("success"))
            }
        }

        delete(Routes.BLOCK, { hidden = true }) {
            call.handleModerationErrors("delete block") {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val blocked = call.parameters["customerId"].orEmpty()
                blockService.unblock(customerId, blocked)
                call.respond(StatusResponse("success"))
            }
        }
    }
}

private suspend inline fun ApplicationCall.handleModerationErrors(action: String, block: () -> Unit) {
    try {
        block()
    } catch (e: ReportNotAllowedException) {
        respond(HttpStatusCode.Forbidden, ErrorResponse(error = e.message.orEmpty()))
    } catch (e: BlockTargetNotFoundException) {
        respond(HttpStatusCode.NotFound, ErrorResponse(error = e.message.orEmpty()))
    } catch (e: IllegalArgumentException) {
        respond(HttpStatusCode.BadRequest, ErrorResponse(error = e.message ?: "Invalid request"))
    } catch (e: SerializationException) {
        respond(HttpStatusCode.BadRequest, ErrorResponse(error = "Invalid request format"))
    } catch (e: BadRequestException) {
        respond(HttpStatusCode.BadRequest, ErrorResponse(error = "Invalid request format"))
    } catch (e: IllegalStateException) {
        // requireAuthenticatedCustomerId already responded (403)
    } catch (e: Exception) {
        logger.error("Failed to {}", action, e)
        respond(HttpStatusCode.InternalServerError, ErrorResponse(error = "Internal server error"))
    }
}
