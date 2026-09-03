package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.models.api.CustomerMemory
import com.genflowly.models.api.GetMemoriesResponse
import com.genflowly.models.api.MemoryKind
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.MemoryRepository
import com.genflowly.providers.RetrievalServerClient
import kotlinx.coroutines.launch
import org.slf4j.LoggerFactory

class MemoryNotFoundException(memoryId: String) : Exception("Memory $memoryId not found")

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
        appScope.launch {
            try {
                retrievalServerClient.deleteMemoryVectors(customerId, memoryId)
            } catch (e: Exception) {
                logger.error("Error deleting vectors for memory $memoryId", e)
            }
        }
    }


    companion object {
        const val MEMORY_ENABLED_KEY = "memoryEnabled"
    }
}
