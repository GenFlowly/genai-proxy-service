package com.genflowly.service

import com.genflowly.di.AppScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch

/**
 * Side-effect work launched after a completed generation exchange, shared by
 * the batch and streaming generation routes: learn about the user from the
 * conversation and index the exchange for semantic conversation search.
 *
 * Learning is DURABLE: [MemoryExtractionService.enqueueConversationExtraction]
 * persists a pending-work row (one small DynamoDB put, suspend) before the
 * background run starts, so a process restart re-dispatches the work via the
 * reconciler instead of silently losing it. Indexing stays fire-and-forget.
 */
class ExchangeSideEffects(
    private val memoryExtractionService: MemoryExtractionService,
    private val conversationIndexingService: ConversationIndexingService,
    private val appScope: AppScope,
) {
    /**
     * [afterStream]: the reply stream of a streamed exchange whose client
     * disconnected mid-reply. Generation runs on without the client and closes
     * that stream only after persisting the reply, so the work waits for the
     * stream to end — off the request, which may already be cancelled — and
     * then reads the stored reply, as it does when the client stays connected.
     */
    suspend fun launchAsync(
        customerId: String,
        conversationId: String,
        client: String,
        userText: String,
        responseMessageId: String,
        bearerToken: String?,
        learnFromConversation: Boolean,
        afterStream: Flow<*>? = null,
    ) {
        if (afterStream != null) {
            appScope.launch {
                afterStream.collect { }
                launchAsync(
                    customerId, conversationId, client, userText,
                    responseMessageId, bearerToken, learnFromConversation
                )
            }
            return
        }
        if (learnFromConversation) {
            memoryExtractionService.enqueueConversationExtraction(
                customerId, conversationId,
                responseMessageId = responseMessageId
            )
        }
        conversationIndexingService.indexExchangeAsync(
            customerId = customerId,
            conversationId = conversationId,
            client = client,
            userText = userText,
            responseMessageId = responseMessageId,
            bearerToken = bearerToken
        )
    }
}
