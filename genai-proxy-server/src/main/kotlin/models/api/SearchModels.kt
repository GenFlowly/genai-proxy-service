package com.genflowly.models.api

import kotlinx.serialization.Serializable

/**
 * One semantically matched item. type says what kind of thing matched
 * ("conversation", "notes", "memory", "email", ...); key is its domain id
 * (conversationId, noteKey, memoryId, messageId respectively).
 */
@Serializable
data class SearchResultItem(
    val type: String,
    val key: String,
    val title: String? = null,
    val snippet: String,
    val score: Double,
    val matchedChunks: Int,
    val createdAt: String? = null
)

@Serializable
data class SearchResponse(
    val results: List<SearchResultItem>
)
