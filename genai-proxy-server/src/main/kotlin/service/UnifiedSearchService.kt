package com.genflowly.service

import com.genflowly.models.Message
import com.genflowly.models.api.SearchResultItem
import com.genflowly.observability.Metrics
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.providers.SearchVectorHit
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.MemoryRepository
import com.genflowly.repository.NotesRepository
import com.genflowly.repository.PendingVectorType
import com.genflowly.repository.VectorSyncPendingRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import org.slf4j.LoggerFactory

/**
 * Unified search across everything the customer has saved — conversations,
 * notes, memories, emails and future data types. Two sources, merged:
 *
 *  - Semantic: the retrieval-server's vector hits, grouped per source item.
 *    Its failures propagate — a search that couldn't run is never reported
 *    as an empty one.
 *  - Keyword: records saved but not yet in the vector DB (VectorSyncPending:
 *    embeds in flight, batch-mode notes waiting for their batch, failed
 *    embeds), matched when they contain every query word. Best-effort: a
 *    failed lookup only drops keyword results.
 *
 * Both get the same per-type visibility rules (owner-only + archived
 * conversations hidden, soft-deleted notes and forgotten memories dropped) and
 * current titles from DynamoDB — the index stores only chunk text and keys.
 * Semantic data types without an enrichment rule pass through as-is, so newly
 * indexed types become searchable without proxy changes.
 */
class UnifiedSearchService(
    private val retrievalServerClient: RetrievalServerClient,
    private val conversationRepository: ConversationRepository,
    private val notesRepository: NotesRepository,
    private val memoryRepository: MemoryRepository,
    private val vectorSyncPendingRepository: VectorSyncPendingRepository,
    private val customerEntitlementService: CustomerEntitlementService
) {
    private val logger = LoggerFactory.getLogger(UnifiedSearchService::class.java)

    /**
     * Throws [com.genflowly.providers.SearchNotConfiguredException] before
     * searching anything when the customer has no vector DB or embedding key.
     */
    suspend fun search(
        customerId: String,
        query: String,
        limit: Int,
        types: List<String>? = null
    ): List<SearchResultItem> = coroutineScope {
        customerEntitlementService.requireSearchable(customerId)
        val keyword = async { keywordMatches(customerId, query, types) }
        val semantic = retrievalServerClient.search(customerId, query, limit, types).mapNotNull { hit ->
            when (hit.type) {
                "conversation" -> enrichConversation(customerId, hit)
                "notes" -> enrichNote(customerId, hit)
                "memory" -> enrichMemory(customerId, hit)
                else -> toResult(hit, title = hit.title)
            }
        }
        KeywordMatcher.mergeKeywordFirst(semantic, keyword.await(), limit) { it.type to it.key }
    }

    // ─── Semantic ─────────────────────────────────────────────────────────────

    private suspend fun enrichConversation(customerId: String, hit: SearchVectorHit): SearchResultItem? {
        val visible = visibleConversation(customerId, hit.key) ?: return null
        return toResult(hit, title = visible.title)
    }

    private suspend fun enrichNote(customerId: String, hit: SearchVectorHit): SearchResultItem? {
        // Vector deletion on note delete is best-effort; the DDB row (which
        // also reflects soft-deletion) is authoritative.
        val note = notesRepository.getNote(customerId, hit.key) ?: return null
        return toResult(hit, title = note["title"]?.s() ?: hit.title)
    }

    // A memory's title is its current text (the vector may hold an older
    // version); the snippet is its category.
    private suspend fun enrichMemory(customerId: String, hit: SearchVectorHit): SearchResultItem? {
        val memory = memoryRepository.getMemory(customerId, hit.key) ?: return null
        return toResult(hit, title = memory.text).copy(snippet = memoryLabel(memory))
    }

    private fun memoryLabel(memory: com.genflowly.models.api.CustomerMemory) =
        memory.category ?: memory.kind.name.lowercase()

    private fun toResult(hit: SearchVectorHit, title: String?) = SearchResultItem(
        type = hit.type,
        key = hit.key,
        title = title?.takeIf { it.isNotBlank() },
        snippet = hit.snippet,
        score = hit.score,
        matchedChunks = hit.matchedChunks,
        createdAt = hit.createdAt.takeIf { it.isNotBlank() }
    )

    // ─── Keyword ──────────────────────────────────────────────────────────────

    private suspend fun keywordMatches(customerId: String, query: String, types: List<String>?): List<SearchResultItem> {
        val matcher = KeywordMatcher(query)
        if (matcher.isEmpty) return emptyList()
        fun wanted(type: PendingVectorType) = types == null || type.token in types
        return coroutineScope {
            listOfNotNull(
                if (wanted(PendingVectorType.CONVERSATION)) async {
                    bestEffort(PendingVectorType.CONVERSATION) { conversationMatches(customerId, matcher) }
                } else null,
                if (wanted(PendingVectorType.NOTE)) async {
                    bestEffort(PendingVectorType.NOTE) { noteMatches(customerId, matcher) }
                } else null,
                if (wanted(PendingVectorType.MEMORY)) async {
                    bestEffort(PendingVectorType.MEMORY) { memoryMatches(customerId, matcher) }
                } else null
            ).awaitAll().flatten()
        }.sortedByDescending { it.createdAt ?: "" }
    }

    private suspend fun bestEffort(
        type: PendingVectorType,
        lookup: suspend () -> List<SearchResultItem>
    ): List<SearchResultItem> = try {
        lookup()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        Metrics.count("search_keyword_failure_total", 1.0, "type" to type.token)
        logger.warn("Keyword search over pending ${type.token} failed: ${e.message}")
        emptyList()
    }

    /** One result per conversation: its newest matching exchange. */
    private suspend fun conversationMatches(customerId: String, matcher: KeywordMatcher): List<SearchResultItem> {
        val pending = vectorSyncPendingRepository
            .listPending(customerId, PendingVectorType.CONVERSATION, KEYWORD_SCAN_LIMIT)
            .mapNotNull { item -> item.conversationId?.let { it to item.key } }
        if (pending.isEmpty()) return emptyList()

        val responses = conversationRepository.getMessages(pending)
        val prompts = conversationRepository
            .getMessages(responses.mapNotNull { r -> r.previousMessageId?.let { r.conversationId to it } })
            .associateBy { it.conversationId to it.messageId }
        fun promptOf(response: Message) = response.previousMessageId?.let { prompts[response.conversationId to it]?.text } ?: ""

        return responses
            .filter { matcher.matches(promptOf(it), it.text) }
            .groupBy { it.conversationId }
            .values
            .mapNotNull { exchanges ->
                val newest = exchanges.maxBy { it.createdAt ?: "" }
                val visible = visibleConversation(customerId, newest.conversationId) ?: return@mapNotNull null
                keywordResult(
                    type = PendingVectorType.CONVERSATION,
                    key = newest.conversationId,
                    title = visible.title,
                    snippet = matcher.snippet(ConversationIndexingService.exchangeText(promptOf(newest), newest.text)),
                    createdAt = newest.createdAt
                )
            }
    }

    private suspend fun noteMatches(customerId: String, matcher: KeywordMatcher): List<SearchResultItem> {
        val pending = vectorSyncPendingRepository.listPending(customerId, PendingVectorType.NOTE, KEYWORD_SCAN_LIMIT)
        if (pending.isEmpty()) return emptyList()
        return notesRepository.getNotesByKeys(customerId, pending.map { it.key }).mapNotNull { note ->
            val noteKey = note["noteKey"]?.s() ?: return@mapNotNull null
            val title = note["title"]?.s()
            val body = note["noteValue"]?.s() ?: ""
            if (!matcher.matches(title, body)) return@mapNotNull null
            keywordResult(
                type = PendingVectorType.NOTE,
                key = noteKey,
                title = title,
                snippet = matcher.snippet(body.ifBlank { title ?: "" }),
                createdAt = note["noteCreatedAt"]?.s() ?: note["createdAt"]?.s()
            )
        }
    }

    private suspend fun memoryMatches(customerId: String, matcher: KeywordMatcher): List<SearchResultItem> {
        val pending = vectorSyncPendingRepository.listPending(customerId, PendingVectorType.MEMORY, KEYWORD_SCAN_LIMIT)
        return pending.mapNotNull { item ->
            val memory = memoryRepository.getMemory(customerId, item.key) ?: return@mapNotNull null
            if (!matcher.matches(memory.text)) return@mapNotNull null
            keywordResult(
                type = PendingVectorType.MEMORY,
                key = memory.memoryId,
                title = memory.text,
                snippet = memoryLabel(memory),
                createdAt = memory.createdAt
            )
        }
    }

    private fun keywordResult(type: PendingVectorType, key: String, title: String?, snippet: String, createdAt: String?) =
        SearchResultItem(
            type = type.token,
            key = key,
            title = title?.takeIf { it.isNotBlank() },
            snippet = snippet,
            matchedChunks = 1,
            createdAt = createdAt?.takeIf { it.isNotBlank() },
            match = SearchResultItem.MATCH_KEYWORD
        )

    // ─── Shared ───────────────────────────────────────────────────────────────

    private class VisibleConversation(val title: String?)

    /** The conversation when this customer may see it in search, else null. */
    private suspend fun visibleConversation(customerId: String, conversationId: String): VisibleConversation? {
        val conversation = conversationRepository.getConversationById(conversationId)
        if (conversation == null || conversation.customerId != customerId) {
            // The collection is per-customer, but never trust the index for
            // access control — a stale or foreign key returns nothing.
            if (conversation != null) {
                logger.warn("Search hit $conversationId is not owned by $customerId — dropping")
            }
            return null
        }
        // Conversations archived before deletes became permanent keep their
        // vectors until they are purged (scratch/purge_archived_items.py).
        if (conversationRepository.isConversationArchived(conversationId, customerId)) return null
        return VisibleConversation(conversationRepository.getConversationTitle(conversationId, customerId))
    }

    companion object {
        /** Most pending records of one type read per search. */
        private const val KEYWORD_SCAN_LIMIT = 200
    }
}
