package com.genflowly.models.api

import kotlinx.serialization.Serializable

@Serializable
data class GetToolCredentialStatusListResponse(
    val toolCredentialStatuses: List<ToolCredentialStatus>,
)
