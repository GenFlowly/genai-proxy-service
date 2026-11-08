package com.genflowly.utils

import io.ktor.server.application.*
import io.ktor.server.auth.*
import io.ktor.server.auth.jwt.*
import io.ktor.http.*
import io.ktor.server.response.*
import com.genflowly.models.ApiKeyPrincipal
import com.genflowly.service.CustomerProfileService

/**
 * Resolve the authenticated customerId from either auth method:
 * - Developer API key: the ApiKeyPrincipal already carries the customerId
 * - Auth0 JWT: resolve via (sub, azp) — the azp claim identifies which app
 *   (web app vs admin panel) the token was issued to, and each app has its
 *   own customer account for the same identity
 *
 * @param customerProfileService Service to fetch customer profile
 * @return customerId if found, null otherwise
 */
suspend fun ApplicationCall.getAuthenticatedCustomerId(
    customerProfileService: CustomerProfileService
): String? {
    // API-key authenticated requests resolve directly
    principal<ApiKeyPrincipal>()?.let { return it.customerId }

    // Extract JWT principal
    val principal = principal<JWTPrincipal>() ?: return null

    // Get sub claim from JWT
    val sub = principal.payload.getClaim("sub").asString() ?: return null

    val azp = principal.payload.getClaim("azp").asString()

    return customerProfileService.getCustomerIdForToken(sub, azp)
}

/**
 * The bearer token from the Authorization header, or null if absent.
 * Used to forward the caller's credentials to internal services
 * (encoding server, retrieval server).
 */
fun ApplicationCall.bearerToken(): String? =
    request.headers[HttpHeaders.Authorization]?.removePrefix("Bearer ")?.trim()

/** The Auth0 sub claim of the authenticated JWT, or null for API-key auth. */
fun ApplicationCall.authenticatedSub(): String? =
    principal<JWTPrincipal>()?.payload?.getClaim("sub")?.asString()

/** The Auth0 azp claim (application clientId) of the authenticated JWT. */
fun ApplicationCall.authenticatedAzp(): String? =
    principal<JWTPrincipal>()?.payload?.getClaim("azp")?.asString()

private val AI_DATA_CONSENT_REQUIRED_STATUS = HttpStatusCode(428, "Precondition Required")

/**
 * False, after responding 428, when the signed-in customer hasn't agreed to the
 * AI data consent screen. Call it on routes that send the customer's content to
 * a third-party service. 428 rather than 403 because the clients read a 403 on
 * these routes as an expired session and sign out. Developer API keys have no
 * consent screen, so they pass.
 */
suspend fun ApplicationCall.ensureAiDataConsent(
    customerProfileService: CustomerProfileService
): Boolean {
    val sub = authenticatedSub() ?: return true
    if (customerProfileService.hasAiDataConsent(sub, authenticatedAzp())) return true
    respond(
        AI_DATA_CONSENT_REQUIRED_STATUS,
        mapOf(
            "error" to "Reload the app and agree to how your data is shared to continue.",
            "code" to "AI_DATA_CONSENT_REQUIRED"
        )
    )
    return false
}

/**
 * Extract sub from JWT and fetch customerId, responding with 403 if not found
 * 
 * @param customerProfileService Service to fetch customer profile
 * @return customerId (throws/responds if not found)
 */
suspend fun ApplicationCall.requireAuthenticatedCustomerId(
    customerProfileService: CustomerProfileService
): String {
    val customerId = getAuthenticatedCustomerId(customerProfileService)
    
    if (customerId == null) {
        respond(HttpStatusCode.Forbidden, mapOf("error" to "Customer profile not found"))
        error("Customer not found for authenticated user")
    }
    
    return customerId
}
