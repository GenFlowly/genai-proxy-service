package com.genflowly.service

import com.genflowly.models.CustomerEntitlements
import com.genflowly.repository.CustomerProfileRepository
import io.mockk.coEvery
import io.mockk.mockk

val ALL_ENTITLEMENTS = CustomerEntitlements(
    isVectorDbStoringEnabled = true, isEmbeddingCreationEnabled = true, isWebSearchEnabled = true
)

/** A real [CustomerEntitlementService] that reads [entitlements] for every customer. */
fun entitlementServiceWith(entitlements: CustomerEntitlements = ALL_ENTITLEMENTS): CustomerEntitlementService {
    val profiles = mockk<CustomerProfileRepository>()
    coEvery { profiles.getEntitlements(any()) } returns entitlements
    return CustomerEntitlementService(profiles, mockk(), mockk())
}
