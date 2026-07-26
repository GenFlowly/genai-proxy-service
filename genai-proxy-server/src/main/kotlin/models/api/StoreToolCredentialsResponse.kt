package com.genflowly.models.api

import kotlinx.serialization.Serializable

@Serializable
data class StoreToolCredentialsResponse(
    val toolCredentialStatus: ToolCredentialStatus,
)
