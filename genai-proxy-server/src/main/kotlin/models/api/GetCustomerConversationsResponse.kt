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
    val vendors: List<String>? = null,
    // Project grouping for the history sidebar. projectName is resolved at
    // read time from the projects table (never denormalized), so a rename
    // shows up immediately; a dangling projectId yields projectName = null.
    val projectId: String? = null,
    val projectName: String? = null,
    // Conversation this one was forked from; the sidebar nests forks under
    // their parent. Null for non-forks and when the parent is unknown.
    val parentConversationId: String? = null,
    // A reply was saved after the owner last read the conversation.
    val unread: Boolean = false
)

@Serializable
data class GetPinnedConversationsResponse(
    val conversations: List<ConversationSummary>,
    /**
     * Opaque cursor for the next page of pinned conversations (same contract
     * as [GetCustomerConversationsResponse.lastEvaluatedKey]). Null when the
     * pinned set fit in one page.
     */
    val lastEvaluatedKey: String? = null
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
