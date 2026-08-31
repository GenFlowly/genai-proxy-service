package com.genflowly.models.api

import kotlinx.serialization.Serializable

/** One conversation matched by semantic search, best-matching snippet first. */
@Serializable
data class ConversationSearchResult(
    val conversationId: String,
    val title: String? = null,
    val snippet: String,
    val score: Double,
    val matchedChunks: Int,
    val createdAt: String? = null
)

@Serializable
data class SearchConversationsResponse(
    val results: List<ConversationSearchResult>
)
