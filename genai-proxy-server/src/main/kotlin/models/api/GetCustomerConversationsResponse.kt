package com.genflowly.models.api

import kotlinx.serialization.Serializable

@Serializable
data class ConversationSummary(
    val conversationId: String,
    val title: String?,
    val createdAt: String?,
    val updatedAt: String?
)

@Serializable
data class GetCustomerConversationsResponse(
    val conversations: List<ConversationSummary>,
    /**
     * Opaque token to pass as [lastEvaluatedKey] in the next request
     * to retrieve the next page. Null when there are no more pages.
     */
    val lastEvaluatedKey: String?
)
