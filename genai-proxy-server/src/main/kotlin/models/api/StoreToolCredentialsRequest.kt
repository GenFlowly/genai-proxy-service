package com.genflowly.models.api

import kotlinx.serialization.Serializable

@Serializable
data class StoreToolCredentialsRequest(
    val toolType: String,
    val authType: String,
    val credentials: Map<String, String>,
)
