package com.genflowly.repository

import com.genflowly.models.AttachmentRef

/**
 * The parts of a Message row the retention paths need (the kept-object claim,
 * its reconciler and backfill, the purge, the shared-conversation download),
 * read with a projection so thinking steps and text are never loaded.
 */
data class MessageFileRefs(
    val conversationId: String,
    val messageId: String,
    val customerId: String?,
    val role: String?,
    val attachments: List<AttachmentRef>,
    val toolResultsJson: String?,
    val fsNamespace: String?,
    val runId: String?,
    val claimPending: Boolean,
    val createdAt: String?
)

/** Primary key of a Message row. */
data class MessageKey(
    val conversationId: String,
    val messageId: String
)

/** One page of a paginated read; [nextPageToken] is null on the last page. */
data class RetentionPage<T>(
    val items: List<T>,
    val nextPageToken: String?
)

/**
 * The Conversation row as the message-write guard sees it. [purgeStartedAt]
 * is set by the conversation purge when it takes its lease: from then on no
 * message may be added to the conversation.
 */
data class ConversationWriteState(
    val ownerCustomerId: String,
    val conversationId: String,
    val archived: Boolean,
    val purgeStartedAt: String?
)
