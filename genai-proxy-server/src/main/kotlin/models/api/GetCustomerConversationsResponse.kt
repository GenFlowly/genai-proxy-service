package com.genflowly.models.api

import com.genflowly.models.ShareRole
import kotlinx.serialization.Serializable

@Serializable
data class ConversationSummary(
    val conversationId: String,
    val title: String?,
    val createdAt: String?,
    val updatedAt: String?,
    val role: ShareRole = ShareRole.OWNER,
    val archivedAt: String? = null,
    val pinnedAt: String? = null,
    val vendors: List<String>? = null
)

@Serializable
data class GetPinnedConversationsResponse(
    val conversations: List<ConversationSummary>
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
