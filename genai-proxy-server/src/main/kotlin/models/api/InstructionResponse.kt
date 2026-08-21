package com.genflowly.models.api

import com.genflowly.models.ShareRole
import kotlinx.serialization.Serializable

@Serializable
data class InstructionResponse(
    val id: String,
    val version: Int,
    val name: String,
    val instruction: String,
    val icon: String? = null,
    val color: String? = null,
    val tags: List<String>? = null,
    val category: String? = null,
    val role: ShareRole = ShareRole.OWNER
)
