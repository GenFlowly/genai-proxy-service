package com.genflowly.models.api

import kotlinx.serialization.Serializable

@Serializable
data class CreateInstructionRequest(
    val instruction: String,
    val instructionName: String,
    val existingInstructionId: String? = null
)

@Serializable
data class CreateInstructionResponse(
    val id: String,
    val version: Int,
    val instructionName: String
)


