package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.models.api.CustomerMemory
import com.genflowly.models.api.GetMemoriesResponse
import com.genflowly.models.api.MemoryKind
import com.genflowly.observability.Metrics
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.MemoryRepository
import com.genflowly.providers.RetrievalServerClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.slf4j.LoggerFactory

class MemoryNotFoundException(memoryId: String) : Exception("Memory $memoryId not found")

/** The customer's memory switches, resolved: true means the customer allows it. */
data class MemorySettings(
    val learnFromChats: Boolean,
    val learnFromNotes: Boolean,
    val useInReplies: Boolean,
) {
    companion object {
        val OFF = MemorySettings(learnFromChats = false, learnFromNotes = false, useInReplies = false)
    }
}

/**
 * User-facing memory management and the governance check for memory use.
 * Learning (extraction) lives in [MemoryExtractionService]; generation-time
 * injection lives in the retrieval server's MEMORY graph node — the Kotlin
 * layer only decides IF memories may be used (consent), never HOW.
 */
class MemoryService(
    private val memoryRepository: MemoryRepository,
    private val customerProfileRepository: CustomerProfileRepository,
    private val retrievalServerClient: RetrievalServerClient,
    private val appScope: AppScope
) {
    private val logger = LoggerFactory.getLogger(MemoryService::class.java)

    /**
     * Each switch is on unless the customer turned it off, or turned memory
     * off as a whole with the legacy otherPreferences.memoryEnabled = "false".
     * A failed read turns everything off for that call: memory runs only
     * when the customer's consent is confirmed.
     */
    suspend fun getMemorySettings(customerId: String): MemorySettings = try {
        val stored = customerProfileRepository.getMemoryPreferences(customerId)
        val memoryOn = stored.legacyMemoryEnabled != "false"
        MemorySettings(
            learnFromChats = memoryOn && stored.learnFromChats != false,
            learnFromNotes = memoryOn && stored.learnFromNotes != false,
            useInReplies = memoryOn && stored.useInReplies != false,
        )
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        Metrics.count("memory_settings_read_failure_total")
        logger.warn("Could not read memory settings for $customerId; memory is off for this call", e)
        MemorySettings.OFF
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
        appScope.launch {
            try {
                retrievalServerClient.deleteMemoryVectors(customerId, memoryId)
            } catch (e: Exception) {
                logger.error("Error deleting vectors for memory $memoryId", e)
            }
        }
    }

    /**
     * Forget everything: hard-deletes every memory in DynamoDB, then their
     * embeddings asynchronously, as [deleteMemory] does for one. Returns how
     * many memories were deleted.
     */
    suspend fun deleteAllMemories(customerId: String): Int {
        val memoryIds = memoryRepository.getMemories(customerId)
            .map { it.memoryId }
            .filter { memoryRepository.deleteMemory(customerId, it) }
        if (memoryIds.isNotEmpty()) {
            appScope.launch {
                memoryIds.forEach { memoryId ->
                    try {
                        retrievalServerClient.deleteMemoryVectors(customerId, memoryId)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        logger.error("Error deleting vectors for memory $memoryId", e)
                    }
                }
            }
        }
        logger.info("Deleted {} memories for customer {}", memoryIds.size, customerId)
        return memoryIds.size
    }
}
