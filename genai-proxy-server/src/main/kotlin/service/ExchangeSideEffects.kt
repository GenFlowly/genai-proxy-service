package com.genflowly.service

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
) {
    suspend fun launchAsync(
        customerId: String,
        conversationId: String,
        client: String,
        userText: String,
        responseMessageId: String,
        bearerToken: String?,
        learnFromConversation: Boolean,
    ) {
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
