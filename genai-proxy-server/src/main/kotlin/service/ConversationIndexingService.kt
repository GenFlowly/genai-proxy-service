package com.genflowly.service

import com.genflowly.EmbeddingConstants
import com.genflowly.di.AppScope
import com.genflowly.models.encoding.EncodingConversationData
import com.genflowly.models.encoding.EncodingSaveConversationRequest
import com.genflowly.providers.EncodingServerClient
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.CustomerProfileRepository
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.launch
import org.slf4j.LoggerFactory

/**
 * Pushes each completed user/assistant exchange into the embedding pipeline so
 * conversations become semantically searchable (see ConversationSearchService).
 * One exchange becomes one CONVERSATION document, keyed by the assistant
 * message id — appending exchanges never re-embeds earlier ones.
 *
 * All entry points are fire-and-forget (appScope) — indexing runs after the
 * user-facing work has completed and must never affect it. The Message table
 * remains the source of truth; the vector index is a best-effort replica.
 */
class ConversationIndexingService(
    private val conversationRepository: ConversationRepository,
    private val customerProfileRepository: CustomerProfileRepository,
    private val encodingServerClient: EncodingServerClient,
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
                val exchangeText =
                    "User: ${userText.take(MAX_SIDE_CHARS)}\nAssistant: ${assistantText.take(MAX_SIDE_CHARS)}"
                if (userText.trim().length + assistantText.trim().length < MIN_EXCHANGE_CHARS) {
                    return@launch
                }

                if (collectionsEnsured.add(customerId)) {
                    // Customers onboarded before the CONVERSATION data type
                    // existed have no conversation collection yet; creation is
                    // idempotent.
                    encodingServerClient.ensureCollections(customerId, "Bearer $bearerToken")
                }

                val prefs = runCatching { customerProfileRepository.getAIConfigPreferences(customerId) }.getOrNull()
                val now = Instant.now().toString()
                encodingServerClient.encodeConversation(
                    EncodingSaveConversationRequest(
                        client = client,
                        modelType = EmbeddingConstants.MODEL_TYPE,
                        modelName = prefs?.embeddingModel ?: EmbeddingConstants.MODEL_NAME,
                        data = EncodingConversationData(
                            conversation_key = conversationId,
                            conversationKey = conversationId,
                            message_key = responseMessageId,
                            messageKey = responseMessageId,
                            text = exchangeText,
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

    companion object {
        // The chunker splits long exchanges downstream; this cap only keeps the
        // ingest payload safely inside SQS/Step Functions message limits.
        private const val MAX_SIDE_CHARS = 30_000

        // Exchanges like "thanks" / "ok" carry no search signal — skip them.
        private const val MIN_EXCHANGE_CHARS = 20
    }
}
