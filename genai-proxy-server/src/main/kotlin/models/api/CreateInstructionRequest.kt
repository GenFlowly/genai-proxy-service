package com.genflowly.models.api

import kotlinx.serialization.Serializable

@Serializable
data class CreateInstructionRequest(
    val instruction: String,
    val instructionName: String? = null,
    val existingInstructionId: String? = null
)




