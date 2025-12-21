package com.genflowly.models

import kotlinx.serialization.Serializable
import models.AIVendorAPIKeyStatus

@Serializable
data class OnboardCustomerResponse(
    val customerId: String,
    val aiConfigPreferences: AIConfigPreferences,
    val aiVendorAPIKeyStatusList: List<AIVendorAPIKeyStatus>
)

