package com.genflowly.models

/**
 * What the customer's stored credentials make possible, kept on their
 * CustomerProfile row. A flag turns on when the customer adds the key or
 * connection it depends on and off when they remove it. Features check the
 * flags first and fail fast when one is off.
 */
data class CustomerEntitlements(
    /** A vector DB connection is stored. */
    val isVectorDbStoringEnabled: Boolean = false,
    /** A stored embedding provider key can embed. */
    val isEmbeddingCreationEnabled: Boolean = false,
    /** A web search key is stored. */
    val isWebSearchEnabled: Boolean = false,
) {
    /** Indexing and semantic search need both; without either, no text is sent to be indexed. */
    val canIndex: Boolean get() = isVectorDbStoringEnabled && isEmbeddingCreationEnabled
}
