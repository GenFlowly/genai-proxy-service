package com.genflowly.models.api

import kotlinx.serialization.Serializable

@Serializable
data class CreateInstructionShareRequest(
    val instructionId: String,
    val targetCustomerId: String,
    val role: String = "VIEW"
)
