package com.genflowly.models.api

import kotlinx.serialization.Serializable

@Serializable
data class GetInstructionListResponse(
    val instructionList: List<Instruction>
)

@Serializable
data class Instruction(
    val id: String,
    val instruction: String,
    val instructionName: String
)
