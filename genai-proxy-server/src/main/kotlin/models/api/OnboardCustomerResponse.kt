package com.genflowly.models.api

import kotlinx.serialization.Serializable
import models.AIVendorAPIKeyStatus
import models.VectorDBConfigStatus
import models.SupabaseConfigStatus

@Serializable
data class OnboardCustomerResponse(
    val customerId: String,
    val aiConfigPreferences: AIConfigPreferences,
    val aiVendorAPIKeyStatusList: List<AIVendorAPIKeyStatus>,
    val customerName: String?,
    val customerPicture: String?,
    val customerInstructions: List<InstructionResponse>?,
    val vectorDBConfigStatusList: List<VectorDBConfigStatus> = emptyList(),
    val supabaseConfigStatus: SupabaseConfigStatus? = null
)

