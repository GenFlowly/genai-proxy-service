package com.genflowly.utils

import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.service.CustomerProfileService
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.response.respond

/**
 * Admin access is an env-configured allowlist checked after normal
 * authentication:
 *  - ADMIN_EMAILS: comma-separated emails (case-insensitive), matched against
 *    the customer's profile email
 *  - ADMIN_CUSTOMER_IDS: comma-separated customerIds
 * A customer matching either list is an admin.
 */
private fun envList(name: String): Set<String> =
    System.getenv(name)
        ?.split(",")
        ?.map { it.trim().lowercase() }
        ?.filter { it.isNotEmpty() }
        ?.toSet()
        ?: emptySet()

suspend fun isAdminCustomer(
    customerId: String,
    customerProfileRepository: CustomerProfileRepository
): Boolean {
    val adminCustomerIds = envList("ADMIN_CUSTOMER_IDS")
    if (customerId.lowercase() in adminCustomerIds) return true

    val adminEmails = envList("ADMIN_EMAILS")
    if (adminEmails.isEmpty()) return false

    val profile = customerProfileRepository.getCustomerProfileByCustomerId(customerId) ?: return false
    val email = profile["email"]?.s()?.trim()?.lowercase() ?: return false
    return email in adminEmails
}

/**
 * Resolve the authenticated customerId and require it to be an admin,
 * responding 403 otherwise.
 */
suspend fun ApplicationCall.requireAdminCustomerId(
    customerProfileService: CustomerProfileService,
    customerProfileRepository: CustomerProfileRepository
): String {
    val customerId = requireAuthenticatedCustomerId(customerProfileService)

    if (!isAdminCustomer(customerId, customerProfileRepository)) {
        respond(HttpStatusCode.Forbidden, mapOf("error" to "Admin access required"))
        error("Customer $customerId is not an admin")
    }

    return customerId
}
