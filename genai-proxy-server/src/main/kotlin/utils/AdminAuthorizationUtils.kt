package com.genflowly.utils

import com.genflowly.config.AppConfig
import com.genflowly.service.CustomerProfileService
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.response.respond

/**
 * Admin access is a config-driven allowlist checked after normal
 * authentication:
 *  - the customer's profile email must be on AppConfig.adminEmailDomain
 *    (customerId-allowlisted accounts are exempt from the domain check)
 *  - AppConfig.adminEmails (ADMIN_EMAILS): matched case-insensitively against
 *    the customer's profile email
 *  - AppConfig.adminCustomerIds (ADMIN_CUSTOMER_IDS)
 * A customer matching either list is an admin.
 */
suspend fun isAdminCustomer(
    customerId: String,
    customerProfileService: CustomerProfileService,
    appConfig: AppConfig
): Boolean {
    if (customerId.lowercase() in appConfig.adminCustomerIds) return true

    if (appConfig.adminEmails.isEmpty()) return false

    val profile = customerProfileService.getProfileByCustomerId(customerId) ?: return false
    val email = profile["email"]?.s()?.trim()?.lowercase() ?: return false
    if (email.substringAfterLast('@', "") != appConfig.adminEmailDomain) return false
    return email in appConfig.adminEmails
}

/**
 * Resolve the authenticated customerId and require it to be an admin,
 * responding 403 otherwise.
 */
suspend fun ApplicationCall.requireAdminCustomerId(
    customerProfileService: CustomerProfileService,
    appConfig: AppConfig
): String {
    val customerId = requireAuthenticatedCustomerId(customerProfileService)

    if (!isAdminCustomer(customerId, customerProfileService, appConfig)) {
        respond(HttpStatusCode.Forbidden, mapOf("error" to "Admin access required"))
        error("Customer $customerId is not an admin")
    }

    return customerId
}
