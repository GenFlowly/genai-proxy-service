package com.genflowly.activity.admin

import com.genflowly.Routes
import com.genflowly.config.AppConfig
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.GetVendorAllowlistResponse
import com.genflowly.models.api.PutVendorAllowlistRequest
import com.genflowly.models.api.VendorAllowlistEntry
import com.genflowly.service.AIModelsService
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.VendorAllowlistService
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

private val logger = LoggerFactory.getLogger("VendorAllowlistActivity")

/**
 * Admin-panel endpoints for the AI vendor allowlist: which of the supported
 * providers customers can see in the react-app. JWT-only, allowlist-gated
 * and hidden from the public OpenAPI spec, same posture as the other admin
 * endpoints.
 */
fun Route.registerVendorAllowlistRoutes(
    vendorAllowlistService: VendorAllowlistService,
    aiModelsService: AIModelsService,
    customerProfileService: CustomerProfileService,
    appConfig: AppConfig
) {
    authenticate("auth0") {
        get(Routes.ADMIN_VENDOR_ALLOWLIST, { hidden = true }) {
            try {
                call.requireAdminCustomerId(customerProfileService, appConfig)
                val allowed = vendorAllowlistService.getAllowedProviderIds()
                val vendors = aiModelsService.getProviderCatalog().providers.map { provider ->
                    VendorAllowlistEntry(
                        id = provider.id,
                        displayName = provider.displayName,
                        native = provider.native,
                        allowed = allowed == null || provider.id in allowed
                    )
                }
                call.respond(GetVendorAllowlistResponse(vendors = vendors, configured = allowed != null))
            } catch (e: IllegalStateException) {
                // requireAdminCustomerId already responded (403)
            } catch (e: Exception) {
                logger.error("Failed to load vendor allowlist", e)
                call.respond(HttpStatusCode.InternalServerError, ErrorResponse(error = "Internal server error"))
            }
        }

        put(Routes.ADMIN_VENDOR_ALLOWLIST, { hidden = true }) {
            try {
                val customerId = call.requireAdminCustomerId(customerProfileService, appConfig)
                val request = call.receive<PutVendorAllowlistRequest>()
                val knownIds = aiModelsService.getProviderCatalog().providers.map { it.id }.toSet()
                val unknown = request.allowedVendors.filter { it.lowercase() !in knownIds }
                if (unknown.isNotEmpty()) {
                    return@put call.respond(
                        HttpStatusCode.BadRequest,
                        ErrorResponse(error = "Unknown vendor id(s): ${unknown.joinToString()}")
                    )
                }
                logger.info(
                    "Admin {} saving vendor allowlist ({} vendor(s))",
                    customerId, request.allowedVendors.size
                )
                vendorAllowlistService.saveAllowedProviderIds(request.allowedVendors, customerId)
                call.respond(HttpStatusCode.OK, mapOf("status" to "success"))
            } catch (e: SerializationException) {
                call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "Invalid request format"))
            } catch (e: IllegalStateException) {
                // requireAdminCustomerId already responded (403)
            } catch (e: Exception) {
                logger.error("Failed to save vendor allowlist", e)
                call.respond(HttpStatusCode.InternalServerError, ErrorResponse(error = "Internal server error"))
            }
        }
    }
}
