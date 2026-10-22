package com.genflowly.models.api

import kotlinx.serialization.Serializable

@Serializable
data class ToolCredentialStatus(
    val toolType: String,
    val authType: String,
    val connected: Boolean,
    val connectedAt: String? = null,
    /** Plain non-secret per-tool config (e.g. WEB_SEARCH's
     * "max_searches_per_turn"). Null when the customer stored none. */
    val settings: Map<String, String>? = null,
)
