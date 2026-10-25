package com.genflowly.activity.admin

import com.genflowly.Routes
import com.genflowly.config.AppConfig
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.GetUsageRateCardResponse
import com.genflowly.models.api.PutUsageRateCardRequest
import com.genflowly.models.api.UsageRateCardEntry
import com.genflowly.repository.UsageRateCardRepository
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.requireAdminCustomerId
import io.github.smiley4.ktoropenapi.get
import io.github.smiley4.ktoropenapi.put
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.SerializationException
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("UsageRateCardActivity")

// Categories this admin UI manages — the only two Cost and Usage categories
// priced at read time (see UsageRollupRepository's doc comment). LLM/
// Embedding are priced from AIModelCatalog instead and have no rate card.
private val MANAGED_CATEGORIES = listOf("vector_db", "web_search")

/**
 * Admin-panel endpoints for the Vector DB / Web Search rate card: the
 * per-unit USD estimate rates UsageSummaryService prices raw op/credit
 * counts against at read time. JWT-only, allowlist-gated and hidden from the
 * public OpenAPI spec, same posture as the other admin endpoints.
 */
fun Route.registerUsageRateCardRoutes(
    usageRateCardRepository: UsageRateCardRepository,
    customerProfileService: CustomerProfileService,
    appConfig: AppConfig
) {
    authenticate("auth0") {
        get(Routes.ADMIN_USAGE_RATE_CARD, { hidden = true }) {
            try {
                call.requireAdminCustomerId(customerProfileService, appConfig)
                val rates = MANAGED_CATEGORIES.flatMap { category ->
                    usageRateCardRepository.getRates(category).map { (rateKey, usdRate) ->
                        UsageRateCardEntry(category = category, rateKey = rateKey, usdRate = usdRate)
                    }
                }
                call.respond(GetUsageRateCardResponse(rates = rates))
            } catch (e: IllegalStateException) {
                // requireAdminCustomerId already responded (403)
            } catch (e: Exception) {
                logger.error("Failed to load usage rate card", e)
                call.respond(HttpStatusCode.InternalServerError, ErrorResponse(error = "Internal server error"))
            }
        }

        put(Routes.ADMIN_USAGE_RATE_CARD, { hidden = true }) {
            try {
                val customerId = call.requireAdminCustomerId(customerProfileService, appConfig)
                val request = call.receive<PutUsageRateCardRequest>()
                if (request.category !in MANAGED_CATEGORIES) {
                    return@put call.respond(
                        HttpStatusCode.BadRequest,
                        ErrorResponse(error = "Unknown category '${request.category}' — expected one of $MANAGED_CATEGORIES")
                    )
                }
                if (request.rateKey.isBlank()) {
                    return@put call.respond(
                        HttpStatusCode.BadRequest, ErrorResponse(error = "rateKey must not be blank")
                    )
                }
                logger.info(
                    "Admin {} setting usage rate card {}/{} = {}",
                    customerId, request.category, request.rateKey, request.usdRate
                )
                usageRateCardRepository.putRate(request.category, request.rateKey, request.usdRate, customerId)
                call.respond(HttpStatusCode.OK, mapOf("status" to "success"))
            } catch (e: SerializationException) {
                call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "Invalid request format"))
            } catch (e: IllegalStateException) {
                // requireAdminCustomerId already responded (403)
            } catch (e: Exception) {
                logger.error("Failed to save usage rate card", e)
                call.respond(HttpStatusCode.InternalServerError, ErrorResponse(error = "Internal server error"))
            }
        }
    }
}
