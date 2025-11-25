package com.genflowly.utils

import io.ktor.server.application.*
import io.ktor.server.auth.*
import io.ktor.server.auth.jwt.*
import io.ktor.http.*
import io.ktor.server.response.*
import service.CustomerProfileService

/**
 * Extract sub from JWT and fetch customerId from CustomerProfileService
 * Queries by sub only (partition key) - does not require client
 * 
 * @param customerProfileService Service to fetch customer profile
 * @return customerId if found, null otherwise
 */
suspend fun ApplicationCall.getAuthenticatedCustomerId(
    customerProfileService: CustomerProfileService
): String? {
    // Extract JWT principal
    val principal = principal<JWTPrincipal>() ?: return null
    
    // Get sub claim from JWT
    val sub = principal.payload.getClaim("sub").asString() ?: return null
    
    // Fetch customerId via service (queries by sub only)
    return customerProfileService.getCustomerIdBySub(sub)
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
