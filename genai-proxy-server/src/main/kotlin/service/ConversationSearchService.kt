package com.genflowly.service

import com.genflowly.models.api.ConversationSearchResult
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.repository.ConversationRepository
import org.slf4j.LoggerFactory

/**
 * Semantic conversation search: the retrieval-server returns vector hits
 * grouped per conversation; this service enforces visibility (owner-only,
 * archived hidden) and enriches hits with the current title from DynamoDB —
 * the index stores only chunk text and keys.
 */
class ConversationSearchService(
    private val retrievalServerClient: RetrievalServerClient,
    private val conversationRepository: ConversationRepository
) {
    private val logger = LoggerFactory.getLogger(ConversationSearchService::class.java)

    suspend fun searchConversations(customerId: String, query: String, limit: Int): List<ConversationSearchResult> {
        val hits = retrievalServerClient.searchConversations(customerId, query, limit)
        if (hits.isEmpty()) return emptyList()

        return hits.mapNotNull { hit ->
            val conversation = conversationRepository.getConversationById(hit.conversationId)
            if (conversation == null || conversation.customerId != customerId) {
                // The collection is per-customer, but never trust the index for
                // access control — a stale or foreign key returns nothing.
                if (conversation != null) {
                    logger.warn("Search hit ${hit.conversationId} is not owned by $customerId — dropping")
                }
                return@mapNotNull null
            }
            // Archive is the product's "delete": hide archived conversations
            // instead of deleting vectors, so unarchiving restores searchability.
            if (conversationRepository.isConversationArchived(hit.conversationId, customerId)) {
                return@mapNotNull null
            }

            ConversationSearchResult(
                conversationId = hit.conversationId,
                title = conversationRepository.getConversationTitle(hit.conversationId, customerId),
                snippet = hit.snippet,
                score = hit.score,
                matchedChunks = hit.matchedChunks,
                createdAt = hit.createdAt.takeIf { it.isNotBlank() }
            )
        }
    }
}
