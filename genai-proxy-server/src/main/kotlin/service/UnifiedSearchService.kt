package com.genflowly.service

import com.genflowly.models.api.SearchResultItem
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.providers.SearchVectorHit
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.MemoryRepository
import com.genflowly.repository.NotesRepository
import org.slf4j.LoggerFactory

/**
 * Unified semantic search across everything the customer has indexed —
 * conversations, notes, memories, emails and future data types. The
 * retrieval-server returns vector hits grouped per source item; this service
 * enforces per-type visibility (owner-only + archived conversations hidden,
 * soft-deleted notes and forgotten memories dropped) and enriches hits with
 * current titles from DynamoDB — the index stores only chunk text and keys.
 *
 * Data types without an enrichment rule pass through as-is, so newly indexed
 * types become searchable without proxy changes.
 */
class UnifiedSearchService(
    private val retrievalServerClient: RetrievalServerClient,
    private val conversationRepository: ConversationRepository,
    private val notesRepository: NotesRepository,
    private val memoryRepository: MemoryRepository
) {
    private val logger = LoggerFactory.getLogger(UnifiedSearchService::class.java)

    suspend fun search(
        customerId: String,
        query: String,
        limit: Int,
        types: List<String>? = null
    ): List<SearchResultItem> {
        val hits = retrievalServerClient.search(customerId, query, limit, types)
        if (hits.isEmpty()) return emptyList()

        return hits.mapNotNull { hit ->
            when (hit.type) {
                "conversation" -> enrichConversation(customerId, hit)
                "notes" -> enrichNote(customerId, hit)
                "memory" -> enrichMemory(customerId, hit)
                else -> toResult(hit, title = hit.title)
            }
        }
    }

    private suspend fun enrichConversation(customerId: String, hit: SearchVectorHit): SearchResultItem? {
        val conversation = conversationRepository.getConversationById(hit.key)
        if (conversation == null || conversation.customerId != customerId) {
            // The collection is per-customer, but never trust the index for
            // access control — a stale or foreign key returns nothing.
            if (conversation != null) {
                logger.warn("Search hit ${hit.key} is not owned by $customerId — dropping")
            }
            return null
        }
        // Archive is the product's "delete": hide archived conversations
        // instead of deleting vectors, so unarchiving restores searchability.
        if (conversationRepository.isConversationArchived(hit.key, customerId)) return null

        return toResult(hit, title = conversationRepository.getConversationTitle(hit.key, customerId))
    }

    private suspend fun enrichNote(customerId: String, hit: SearchVectorHit): SearchResultItem? {
        // Vector deletion on note delete is best-effort; the DDB row (which
        // also reflects soft-deletion) is authoritative.
        val note = notesRepository.getNote(customerId, hit.key) ?: return null
        return toResult(hit, title = note["title"]?.s() ?: hit.title)
    }

    private suspend fun enrichMemory(customerId: String, hit: SearchVectorHit): SearchResultItem? {
        memoryRepository.getMemory(customerId, hit.key) ?: return null
        return toResult(hit, title = hit.title)
    }

    private fun toResult(hit: SearchVectorHit, title: String?) = SearchResultItem(
        type = hit.type,
        key = hit.key,
        title = title?.takeIf { it.isNotBlank() },
        snippet = hit.snippet,
        score = hit.score,
        matchedChunks = hit.matchedChunks,
        createdAt = hit.createdAt.takeIf { it.isNotBlank() }
    )
}
