package com.genflowly.service

import com.genflowly.EmbeddingConstants
import com.genflowly.di.AppScope
import com.genflowly.models.encoding.EncodingConversationData
import com.genflowly.models.encoding.EncodingSaveConversationRequest
import com.genflowly.providers.EncodingServerClient
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.providers.VectorEncodeException
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.PendingVectorType
import com.genflowly.repository.VectorSyncPendingRepository
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.launch
import org.slf4j.LoggerFactory

/**
 * Pushes each completed user/assistant exchange into the embedding pipeline so
 * conversations become semantically searchable (see UnifiedSearchService).
 * One exchange becomes one CONVERSATION document, keyed by the assistant
 * message id — appending exchanges never re-embeds earlier ones.
 *
 * Each exchange is recorded in VectorSyncPending before it is sent: search
 * keyword-matches it until the pipeline's store step deletes that row, and the
 * row's scheduled retry ([VectorRetryService] → [retryExchange]) re-embeds it
 * if the pipeline never lands. Customers without a vector DB are skipped
 * entirely: nothing could index their exchanges, and connecting one later
 * does not backfill.
 *
 * All entry points are fire-and-forget (appScope) — indexing runs after the
 * user-facing work has completed and must never affect it. The Message table
 * remains the source of truth; the vector index is a best-effort replica.
 */
class ConversationIndexingService(
    private val conversationRepository: ConversationRepository,
    private val customerProfileRepository: CustomerProfileRepository,
    private val customerEntitlementService: CustomerEntitlementService,
    private val vectorSyncPendingRepository: VectorSyncPendingRepository,
    private val encodingServerClient: EncodingServerClient,
    private val retrievalServerClient: RetrievalServerClient,
    private val appScope: AppScope
) {
    private val logger = LoggerFactory.getLogger(ConversationIndexingService::class.java)

    // Customers whose vector collections were already ensured by this process.
    // ensureCollections is idempotent server-side; this only trims HTTP calls.
    private val collectionsEnsured = ConcurrentHashMap.newKeySet<String>()

    /**
     * Indexes the exchange ending in [responseMessageId]. The assistant text is
     * read back from the Message table because streaming callers don't hold the
     * full response when the request handler finishes.
     */
    fun indexExchangeAsync(
        customerId: String,
        conversationId: String,
        client: String,
        userText: String,
        responseMessageId: String,
        bearerToken: String?
    ) {
        if (bearerToken == null) return
        appScope.launch {
            try {
                val assistantText = conversationRepository
                    .getMessage(conversationId, responseMessageId)?.text ?: ""
                if (userText.trim().length + assistantText.trim().length < MIN_EXCHANGE_CHARS) {
                    return@launch
                }
                // Sent only when it can be both embedded and stored. Flags that
                // can't be read must not drop the exchange.
                if (customerEntitlementService.getOrNull(customerId)?.canIndex == false) {
                    return@launch
                }

                try {
                    vectorSyncPendingRepository.markPending(
                        customerId, PendingVectorType.CONVERSATION, responseMessageId,
                        conversationId = conversationId,
                        retryAt = Instant.now().plusSeconds(FIRST_RETRY_DELAY_SECONDS)
                    )
                } catch (e: Exception) {
                    // The exchange is still sent; it just isn't keyword-findable
                    // or retried if the pipeline fails.
                    logger.warn("Could not record $responseMessageId as pending: ${e.message}")
                }

                val model = embeddingModel(customerId)
                if (collectionsEnsured.add(customerId)) {
                    // Customers onboarded before the CONVERSATION data type
                    // existed have no conversation collection yet; creation is
                    // idempotent.
                    encodingServerClient.ensureCollections(customerId, "Bearer $bearerToken", model)
                }
                val now = Instant.now().toString()
                encodingServerClient.encodeConversation(
                    EncodingSaveConversationRequest(
                        client = client,
                        modelType = EmbeddingConstants.modelTypeFor(model),
                        modelName = model ?: EmbeddingConstants.MODEL_NAME,
                        data = EncodingConversationData(
                            conversation_key = conversationId,
                            conversationKey = conversationId,
                            message_key = responseMessageId,
                            messageKey = responseMessageId,
                            text = exchangeText(userText, assistantText),
                            title = "",
                            created_at = now,
                            createdAt = now
                        )
                    ),
                    bearerToken
                )
            } catch (e: Exception) {
                logger.warn("Conversation indexing for $conversationId/$responseMessageId failed: ${e.message}")
            }
        }
    }

    /**
     * Re-embeds one exchange directly through the retrieval-server, rebuilt
     * from the Message table. Returns false when the exchange no longer
     * exists. Throws when the embed fails, with a permanent
     * [VectorEncodeException] when the customer can't index.
     */
    suspend fun retryExchange(customerId: String, conversationId: String, responseMessageId: String): Boolean {
        if (customerEntitlementService.getOrNull(customerId)?.canIndex == false) {
            throw VectorEncodeException(409, "Customer $customerId has no vector DB or embedding key")
        }
        val response = conversationRepository.getMessage(conversationId, responseMessageId) ?: return false
        val userText = response.previousMessageId
            ?.let { conversationRepository.getMessage(conversationId, it)?.text }
            ?: ""
        val model = embeddingModel(customerId)
        retrievalServerClient.encodeConversationVector(
            customerId = customerId,
            conversationId = conversationId,
            messageId = responseMessageId,
            text = exchangeText(userText, response.text),
            createdAt = response.createdAt ?: Instant.now().toString(),
            client = response.client.ifBlank { "web" },
            modelType = EmbeddingConstants.modelTypeFor(model),
            modelName = model ?: EmbeddingConstants.MODEL_NAME
        )
        return true
    }

    private suspend fun embeddingModel(customerId: String): String? {
        val prefs = runCatching { customerProfileRepository.getAIConfigPreferences(customerId) }.getOrNull()
        return prefs?.embeddingModelConversations ?: prefs?.embeddingModel
    }

    companion object {
        // The chunker splits long exchanges downstream; this cap only keeps the
        // ingest payload safely inside SQS/Step Functions message limits.
        private const val MAX_SIDE_CHARS = 30_000

        // Exchanges like "thanks" / "ok" carry no search signal — skip them.
        private const val MIN_EXCHANGE_CHARS = 20

        // The pipeline normally stores an exchange within a minute; the retry
        // only runs if it hasn't by then.
        const val FIRST_RETRY_DELAY_SECONDS = 300L

        fun exchangeText(userText: String, assistantText: String) =
            "User: ${userText.take(MAX_SIDE_CHARS)}\nAssistant: ${assistantText.take(MAX_SIDE_CHARS)}"
    }
}
