package com.genflowly.models.api

import kotlinx.serialization.Serializable

/**
 * Lightweight conversation metadata for link-preview (Open Graph) rendering.
 * Deliberately excludes messages: the edge worker fetches this on every
 * /chat/:id page load.
 */
@Serializable
data class GetConversationMetaResponse(
    /** Null when the conversation has no generated title yet. */
    val title: String? = null
)
