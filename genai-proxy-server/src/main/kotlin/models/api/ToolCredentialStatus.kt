package com.genflowly.models.api

import kotlinx.serialization.Serializable

@Serializable
data class ToolCredentialStatus(
    val toolType: String,
    val authType: String,
    val connected: Boolean,
    val connectedAt: String? = null,
)
