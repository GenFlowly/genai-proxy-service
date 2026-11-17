package com.genflowly.activity.usage

import com.genflowly.Routes
import com.genflowly.models.api.ErrorResponse
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.UsageSummaryService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import java.time.LocalDate
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("UsageActivity")

/**
 * Cost and Usage settings pages: per-customer usage/cost summaries over a
 * date range, backed by the CustomerAIUsage rollup (see
 * UsageRollupRepository). Web-app only (Auth0 JWT) — developer API keys are
 * not currently extended here, matching Notes/Search.
 *
 * All four endpoints are live. Web Search is always an ESTIMATE
 * (isEstimate=true) — see UsageSummaryService.getWebSearchUsage. Vector DB
 * carries no cost figure at all (Zilliz bills by data size/compute units,
 * not per operation call) — see getVectorDbUsage.
 */
fun Route.registerUsageRoutes(
    usageSummaryService: UsageSummaryService,
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0") {
        get(Routes.USAGE_LLM, {
            tags("Usage")
            summary = "Per-customer LLM cost/usage summary"
            description = "Totals + per-vendor + per-model breakdown + per-day series (byDay, UTC dates with usage) for a date range. Web-app only."
        }) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val (from, to) = call.resolveDateRange() ?: return@get call.respond(
                    HttpStatusCode.BadRequest, ErrorResponse(error = "from/to must be YYYY-MM-DD")
                )
                call.respond(HttpStatusCode.OK, usageSummaryService.getLlmUsage(customerId, from, to))
            } catch (e: IllegalStateException) {
                // requireAuthenticatedCustomerId already responded (403)
            } catch (e: Exception) {
                logger.error("Failed to fetch LLM usage", e)
                call.respond(HttpStatusCode.InternalServerError, ErrorResponse(error = "Internal server error"))
            }
        }

        get(Routes.USAGE_EMBEDDING, {
            tags("Usage")
            summary = "Per-customer embedding cost/usage summary"
            description = "Totals + per-vendor + per-model breakdown + per-day series (byDay, UTC dates with usage) for a date range. Web-app only."
        }) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val (from, to) = call.resolveDateRange() ?: return@get call.respond(
                    HttpStatusCode.BadRequest, ErrorResponse(error = "from/to must be YYYY-MM-DD")
                )
                call.respond(HttpStatusCode.OK, usageSummaryService.getEmbeddingUsage(customerId, from, to))
            } catch (e: IllegalStateException) {
                // requireAuthenticatedCustomerId already responded (403)
            } catch (e: Exception) {
                logger.error("Failed to fetch embedding usage", e)
                call.respond(HttpStatusCode.InternalServerError, ErrorResponse(error = "Internal server error"))
            }
        }

        get(Routes.USAGE_VECTOR_DB, {
            tags("Usage")
            summary = "Per-customer vector DB operation counts"
            description = "Raw search/query/insert/upsert/delete counts for a date range — no cost figure (Zilliz bills by data size/compute, not per operation). Web-app only."
        }) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val (from, to) = call.resolveDateRange() ?: return@get call.respond(
                    HttpStatusCode.BadRequest, ErrorResponse(error = "from/to must be YYYY-MM-DD")
                )
                call.respond(HttpStatusCode.OK, usageSummaryService.getVectorDbUsage(customerId, from, to))
            } catch (e: IllegalStateException) {
                // requireAuthenticatedCustomerId already responded (403)
            } catch (e: Exception) {
                logger.error("Failed to fetch vector DB usage", e)
                call.respond(HttpStatusCode.InternalServerError, ErrorResponse(error = "Internal server error"))
            }
        }

        get(Routes.USAGE_WEB_SEARCH, {
            tags("Usage")
            summary = "Per-customer estimated web search usage"
            description = "Credit-volume estimate for a date range (isEstimate=true) — never a real Tavily bill. Web-app only."
        }) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val (from, to) = call.resolveDateRange() ?: return@get call.respond(
                    HttpStatusCode.BadRequest, ErrorResponse(error = "from/to must be YYYY-MM-DD")
                )
                call.respond(HttpStatusCode.OK, usageSummaryService.getWebSearchUsage(customerId, from, to))
            } catch (e: IllegalStateException) {
                // requireAuthenticatedCustomerId already responded (403)
            } catch (e: Exception) {
                logger.error("Failed to fetch web search usage", e)
                call.respond(HttpStatusCode.InternalServerError, ErrorResponse(error = "Internal server error"))
            }
        }
    }
}

/**
 * Parses from/to query params, defaulting to a trailing-30-day window when
 * absent. Null return means the caller passed something unparseable.
 */
private fun io.ktor.server.application.ApplicationCall.resolveDateRange(): Pair<String, String>? {
    val toParam = request.queryParameters["to"]
    val fromParam = request.queryParameters["from"]

    val toDate = if (toParam == null) LocalDate.now()
        else runCatching { LocalDate.parse(toParam) }.getOrNull() ?: return null
    val fromDate = if (fromParam == null) toDate.minusDays(30)
        else runCatching { LocalDate.parse(fromParam) }.getOrNull() ?: return null

    return Pair(fromDate.toString(), toDate.toString())
}
