package com.genflowly.models.api

import kotlinx.serialization.Serializable
import com.genflowly.models.AIVendorAPIKeyStatus
import com.genflowly.models.VectorDBConfigStatus
import com.genflowly.models.SupabaseConfigStatus

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

