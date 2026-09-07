package com.genflowly.service

/**
 * Fire-and-forget work launched after a completed generation exchange,
 * shared by the batch and streaming generation routes: learn about the
 * user from the conversation (debounced inside MemoryExtractionService)
 * and index the exchange for semantic conversation search.
 */
class ExchangeSideEffects(
    private val memoryExtractionService: MemoryExtractionService,
    private val conversationIndexingService: ConversationIndexingService,
) {
    fun launchAsync(
        customerId: String,
        conversationId: String,
        client: String,
        userText: String,
        responseMessageId: String,
        bearerToken: String?,
        learnFromConversation: Boolean,
    ) {
        if (learnFromConversation) {
            memoryExtractionService.maybeExtractFromConversationAsync(
                customerId, conversationId, bearerToken,
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
