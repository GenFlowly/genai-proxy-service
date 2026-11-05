package com.genflowly.models.api

import kotlinx.serialization.Serializable

/**
 * One matched item. type says what kind of thing matched ("conversation",
 * "notes", "memory", "email", ...); key is its domain id (conversationId,
 * noteKey, memoryId, messageId respectively). match is "semantic" for a
 * vector-DB hit (with its similarity score) or "keyword" for a record not yet
 * in the vector DB that contains every query word (no score).
 */
@Serializable
data class SearchResultItem(
    val type: String,
    val key: String,
    val title: String? = null,
    val snippet: String,
    val score: Double? = null,
    val matchedChunks: Int,
    val createdAt: String? = null,
    val match: String = MATCH_SEMANTIC
) {
    companion object {
        const val MATCH_SEMANTIC = "semantic"
        const val MATCH_KEYWORD = "keyword"
    }
}

@Serializable
data class SearchResponse(
    val results: List<SearchResultItem>
)

/**
 * A search that couldn't run. code is SEARCH_NOT_CONFIGURED (409: the
 * customer must add the setting named by reason, VECTOR_DB_NOT_CONFIGURED or
 * EMBEDDING_KEY_MISSING; retrying won't help) or SEARCH_UNAVAILABLE (502).
 */
@Serializable
data class SearchErrorResponse(
    val error: String,
    val code: String,
    val reason: String? = null
) {
    companion object {
        const val NOT_CONFIGURED = "SEARCH_NOT_CONFIGURED"
        const val UNAVAILABLE = "SEARCH_UNAVAILABLE"
    }
}
