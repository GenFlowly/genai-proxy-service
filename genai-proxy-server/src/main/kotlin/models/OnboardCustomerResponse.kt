package com.genflowly.models

import kotlinx.serialization.Serializable

@Serializable
data class OnboardCustomerResponse(
    val customerId: String
)

