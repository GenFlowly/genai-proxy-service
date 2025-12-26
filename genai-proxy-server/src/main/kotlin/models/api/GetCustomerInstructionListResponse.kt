package com.genflowly.models.api

import kotlinx.serialization.Serializable

@Serializable
data class GetCustomerInstructionListResponse(
    val instructions: List<InstructionResponseItem>
)

@Serializable
data class InstructionResponseItem(
    val id: String,
    val name: String,
    val version: Int,
    val instruction: String
)
