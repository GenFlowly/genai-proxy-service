package com.genflowly.service

import com.genflowly.EmbeddingConstants
import com.genflowly.models.api.CustomerMemory
import com.genflowly.observability.Metrics
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.providers.VectorEncodeException
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.MemoryRepository
import com.genflowly.repository.PendingVectorType
import com.genflowly.repository.VectorSyncPendingRepository
import java.time.Instant
import kotlinx.coroutines.CancellationException
import org.slf4j.LoggerFactory

/**
 * Keeps a memory's vector in step with its text, for semantic recall. Every
 * call is best effort: a failed embed is recorded in VectorSyncPending and
 * retried by [VectorRetryService]; a permanent failure is not. Nothing is
 * sent for a customer whose entitlements say they can't index (no vector DB
 * or embedding key).
 */
class MemoryVectorService(
    private val memoryRepository: MemoryRepository,
    private val customerProfileRepository: CustomerProfileRepository,
    private val retrievalServerClient: RetrievalServerClient,
    private val vectorSyncPendingRepository: VectorSyncPendingRepository,
    private val customerEntitlementService: CustomerEntitlementService,
) {
    private val logger = LoggerFactory.getLogger(MemoryVectorService::class.java)

    /**
     * Pushes the memory's current text into the vector store, via the
     * retrieval server's service-to-service /encode-memory (no end-user
     * bearer token, so retries embed exactly like live writes). The encode
     * replaces the memory's earlier vectors rather than adding to them.
     */
    suspend fun encode(customerId: String, memory: CustomerMemory) {
        if (!canIndex(customerId)) return
        try {
            embed(customerId, memory)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Metrics.count("memory_vector_failure_total", 1.0, "operation" to "encode")
            logger.error("Failed to encode memory ${memory.memoryId} for $customerId", e)
            if ((e as? VectorEncodeException)?.permanent == true) return
            try {
                vectorSyncPendingRepository.markPending(
                    customerId, PendingVectorType.MEMORY, memory.memoryId,
                    retryAt = Instant.now().plusSeconds(FIRST_RETRY_DELAY_SECONDS)
                )
            } catch (markError: Exception) {
                logger.warn("Could not schedule a vector retry for memory ${memory.memoryId}: ${markError.message}")
            }
        }
    }

    /**
     * Re-embeds a memory's current text. Returns false when the memory no
     * longer exists. Throws when the embed fails, with a permanent
     * [VectorEncodeException] when the customer can't index.
     */
    suspend fun retry(customerId: String, memoryId: String): Boolean {
        if (!canIndex(customerId)) {
            throw VectorEncodeException(409, "Customer $customerId has no vector DB or embedding key")
        }
        val memory = memoryRepository.getMemory(customerId, memoryId) ?: return false
        embed(customerId, memory)
        return true
    }

    suspend fun delete(customerId: String, memoryId: String) {
        try {
            retrievalServerClient.deleteMemoryVectors(customerId, memoryId)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Metrics.count("memory_vector_failure_total", 1.0, "operation" to "delete")
            logger.error("Failed to delete vectors for memory $memoryId", e)
        }
    }

    private suspend fun embed(customerId: String, memory: CustomerMemory) {
        val prefs = runCatching { customerProfileRepository.getAIConfigPreferences(customerId) }.getOrNull()
        // Memories are extracted from conversations, so they follow the
        // conversations-category default.
        val model = prefs?.embeddingModelConversations ?: prefs?.embeddingModel
        retrievalServerClient.encodeMemoryVector(
            customerId = customerId,
            memoryKey = memory.memoryId,
            memoryValue = memory.text,
            title = "[memory] ${memory.category ?: memory.kind.name.lowercase()}",
            createdAt = memory.createdAt,
            modelType = EmbeddingConstants.modelTypeFor(model),
            modelName = model ?: EmbeddingConstants.MODEL_NAME,
        )
    }

    /** Flags that can't be read count as entitled: a failed read never drops a vector. */
    private suspend fun canIndex(customerId: String): Boolean =
        customerEntitlementService.getOrNull(customerId)?.canIndex != false

    private companion object {
        const val FIRST_RETRY_DELAY_SECONDS = 60L
    }
}
