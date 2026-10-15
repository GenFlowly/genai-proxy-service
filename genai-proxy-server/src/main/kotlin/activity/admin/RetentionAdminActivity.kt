package com.genflowly.activity.admin

import com.genflowly.Routes
import com.genflowly.config.AppConfig
import com.genflowly.models.api.ClaimBackfillRequest
import com.genflowly.models.api.ErrorResponse
import com.genflowly.service.AccountDeletionService
import com.genflowly.service.ClaimBackfillService
import com.genflowly.service.CustomerNotFoundException
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.requireAdminCustomerId
import io.github.smiley4.ktoropenapi.delete
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

private val logger = LoggerFactory.getLogger("RetentionAdminActivity")

/**
 * The admin's customerId, or null after a 403 was sent (not an admin, or no
 * profile). Kept apart from the handler body so an IllegalStateException
 * raised by the work itself is not mistaken for the auth refusal.
 */
private suspend fun io.ktor.server.application.ApplicationCall.requireAdminOrNull(
    customerProfileService: CustomerProfileService,
    appConfig: AppConfig
): String? = try {
    requireAdminCustomerId(customerProfileService, appConfig)
} catch (e: IllegalStateException) {
    null
}

/**
 * Admin-only retention operations: customer deletion (plan 3.9) and the
 * one-time kept-object claim backfill (plan 1.13). JWT-only,
 * ADMIN_EMAILS-gated and hidden from the public OpenAPI spec, like the other
 * admin endpoints. There is deliberately no self-service deletion route.
 */
fun Route.registerRetentionAdminRoutes(
    claimBackfillService: ClaimBackfillService,
    accountDeletionService: AccountDeletionService,
    customerProfileService: CustomerProfileService,
    appConfig: AppConfig
) {
    authenticate("auth0") {
        /**
         * Deletes a customer: creates the account purge job and answers 202
         * with its status. Idempotent - a repeated request returns the
         * existing job. The job runs in the background (PurgeJobWorker).
         */
        delete(Routes.ADMIN_DELETE_CUSTOMER, { hidden = true }) {
            val adminId = call.requireAdminOrNull(customerProfileService, appConfig) ?: return@delete
            try {
                val customerId = call.parameters["customerId"]?.trim()
                if (customerId.isNullOrBlank()) {
                    return@delete call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "customerId is required"))
                }
                val result = accountDeletionService.requestDeletion(customerId, adminId)
                val status = accountDeletionService.status(customerId)
                    ?.copy(created = result.created)
                    ?: return@delete call.respond(HttpStatusCode.InternalServerError, ErrorResponse(error = "Job not found"))
                call.respond(HttpStatusCode.Accepted, status)
            } catch (e: CustomerNotFoundException) {
                call.respond(HttpStatusCode.NotFound, ErrorResponse(error = "Customer not found"))
            } catch (e: IllegalArgumentException) {
                call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = e.message ?: "Invalid request"))
            } catch (e: Exception) {
                logger.error("Customer deletion request failed", e)
                call.respond(HttpStatusCode.InternalServerError, ErrorResponse(error = "Internal server error"))
            }
        }

        get(Routes.ADMIN_CUSTOMER_DELETION_STATUS, { hidden = true }) {
            call.requireAdminOrNull(customerProfileService, appConfig) ?: return@get
            try {
                val customerId = call.request.queryParameters["customerId"]?.trim()
                if (customerId.isNullOrBlank()) {
                    return@get call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "customerId is required"))
                }
                val status = accountDeletionService.status(customerId)
                    ?: return@get call.respond(HttpStatusCode.NotFound, ErrorResponse(error = "No deletion for this customer"))
                call.respond(status)
            } catch (e: Exception) {
                logger.error("Customer deletion status failed", e)
                call.respond(HttpStatusCode.InternalServerError, ErrorResponse(error = "Internal server error"))
            }
        }

        /**
         * Claims (tags kept) every object linked from one page of Message rows.
         * Call repeatedly with the returned nextPageToken until done; safe to
         * re-run from any token. See development.md "Retention" for when to
         * run it relative to enabling the pending expiry rule.
         */
        post(Routes.ADMIN_RETENTION_CLAIM_BACKFILL, { hidden = true }) {
            val adminId = call.requireAdminOrNull(customerProfileService, appConfig) ?: return@post
            try {
                val request = call.receive<ClaimBackfillRequest>()
                val result = claimBackfillService.runPage(
                    request.pageToken, request.maxItems ?: ClaimBackfillService.DEFAULT_MAX_ITEMS
                )
                logger.info(
                    "Admin {} ran a kept-object backfill page: {} scanned, done={}",
                    adminId, result.scannedMessages, result.done
                )
                call.respond(result)
            } catch (e: IllegalArgumentException) {
                call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = e.message ?: "Invalid request"))
            } catch (e: SerializationException) {
                call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "Invalid request format"))
            } catch (e: BadRequestException) {
                call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "Invalid request format"))
            } catch (e: Exception) {
                logger.error("Kept-object backfill page failed", e)
                call.respond(HttpStatusCode.InternalServerError, ErrorResponse(error = "Internal server error"))
            }
        }
    }
}
