package com.genflowly.models.api

import kotlinx.serialization.Serializable
import models.AIVendorAPIKeyStatus

@Serializable
data class OnboardCustomerResponse(
    val customerId: String,
    val aiConfigPreferences: AIConfigPreferences,
    val aiVendorAPIKeyStatusList: List<AIVendorAPIKeyStatus>,
    val customerName: String?,
    val customerPicture: String?,
    val customerInstructions: List<InstructionResponseItem>?
)

