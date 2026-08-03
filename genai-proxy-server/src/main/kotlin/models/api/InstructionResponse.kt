package com.genflowly.models.api

import kotlinx.serialization.Serializable

@Serializable
data class InstructionResponse(
    val id: String,
    val version: Int,
    val name: String,
    val instruction: String,
    val role: String = "OWNER"
)
