package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.models.api.CustomerMemory
import com.genflowly.models.api.GetMemoriesResponse
import com.genflowly.models.api.MemoryKind
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.MemoryRepository
import com.genflowly.providers.RetrievalServerClient
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.launch
import org.slf4j.LoggerFactory

class MemoryNotFoundException(memoryId: String) : Exception("Memory $memoryId not found")

/**
 * User-facing memory management plus the generation-time injection of learned
 * memories into the system prompt. Learning (extraction) lives in
 * [MemoryExtractionService]; this service only reads and deletes.
 */
class MemoryService(
    private val memoryRepository: MemoryRepository,
    private val customerProfileRepository: CustomerProfileRepository,
    private val retrievalServerClient: RetrievalServerClient,
    private val appScope: AppScope
) {
    private val logger = LoggerFactory.getLogger(MemoryService::class.java)

    private data class CacheEntry(val block: String, val fetchedAt: Long)

    // Rendered CORE-memory block per customer. Memories change rarely relative
    // to chat traffic, so a short TTL keeps every generation request at zero
    // extra DDB reads in the common case; writers call invalidate().
    private val blockCache = ConcurrentHashMap<String, CacheEntry>()

    /**
     * Memory learning/injection is on unless the customer explicitly disabled
     * it (otherPreferences.memoryEnabled = "false"). Preference-read failures
     * count as enabled — memory is an enhancement, never worth failing over.
     */
    suspend fun isMemoryEnabled(customerId: String): Boolean = try {
        customerProfileRepository.getOtherPreferences(customerId)[MEMORY_ENABLED_KEY] != "false"
    } catch (e: Exception) {
        logger.warn("Could not read memory preference for $customerId; assuming enabled", e)
        true
    }

    suspend fun getMemories(customerId: String): GetMemoriesResponse =
        GetMemoriesResponse(memories = memoryRepository.getMemories(customerId).sortedByDescending { it.updatedAt })

    /**
     * Delete a memory: hard delete in DynamoDB and async hard-delete of its
     * embeddings (same fire-and-forget convention as note deletion).
     */
    suspend fun deleteMemory(customerId: String, memoryId: String) {
        val existed = memoryRepository.deleteMemory(customerId, memoryId)
        if (!existed) {
            throw MemoryNotFoundException(memoryId)
        }
        invalidate(customerId)
        appScope.launch {
            try {
                retrievalServerClient.deleteMemoryVectors(customerId, memoryId)
            } catch (e: Exception) {
                logger.error("Error deleting vectors for memory $memoryId", e)
            }
        }
    }

    /**
     * Appends the customer's CORE memories to the system prompt so durable
     * facts shape every response, retrieval or not. Any failure returns the
     * prompt unchanged — memory must never break generation.
     */
    suspend fun withMemoryBlock(customerId: String, systemPrompt: String): String {
        val block = try {
            memoryBlock(customerId)
        } catch (e: Exception) {
            logger.warn("Failed to load memories for $customerId; proceeding without", e)
            return systemPrompt
        }
        if (block.isEmpty()) return systemPrompt
        return if (systemPrompt.isBlank()) block else "$systemPrompt\n\n$block"
    }

    fun invalidate(customerId: String) {
        blockCache.remove(customerId)
    }

    private suspend fun memoryBlock(customerId: String): String {
        blockCache[customerId]?.let { cached ->
            if (System.currentTimeMillis() - cached.fetchedAt < CACHE_TTL_MS) return cached.block
        }
        val block = if (!isMemoryEnabled(customerId)) {
            ""
        } else {
            renderBlock(memoryRepository.getMemories(customerId))
        }
        blockCache[customerId] = CacheEntry(block, System.currentTimeMillis())
        return block
    }

    private fun renderBlock(memories: List<CustomerMemory>): String {
        val core = memories.filter { it.kind == MemoryKind.CORE }
            .sortedByDescending { it.updatedAt }
            .take(MAX_INJECTED_MEMORIES)
        if (core.isEmpty()) return ""
        return buildString {
            append("## What you know about this user\n")
            append("Learned from earlier conversations and notes; apply when relevant, never claim the user just told you:\n")
            core.forEach { append("- ").append(it.text).append('\n') }
        }.trimEnd()
    }

    companion object {
        const val MEMORY_ENABLED_KEY = "memoryEnabled"
        private const val CACHE_TTL_MS = 60_000L
        private const val MAX_INJECTED_MEMORIES = 20
    }
}
