package com.genflowly.models.api

import kotlinx.serialization.Serializable

@Serializable
data class GetCustomerInstructionListResponse(
    val instructions: List<InstructionResponse>
)
