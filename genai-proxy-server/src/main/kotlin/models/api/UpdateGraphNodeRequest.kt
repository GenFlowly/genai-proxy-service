package com.genflowly.models.api

import kotlinx.serialization.Serializable

@Serializable
data class UpdateGraphNodeRequest(
    val nodeType: String? = null,
    val name: String? = null,
    val config: String? = null,
)
