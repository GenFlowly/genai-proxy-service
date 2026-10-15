package com.genflowly.models.api

import kotlinx.serialization.Serializable

/** DELETE /admin/customers/{customerId} (202) and GET /admin/customers/deletion. */
@Serializable
data class AccountDeletionStatusResponse(
    val customerId: String,
    val jobKey: String,
    /** PENDING, RUNNING or DONE. */
    val state: String,
    /** Last account-job step completed (1 writes stopped ... 5 rows deleted). */
    val stage: Int,
    /** Failed attempts so far (alerting starts at 10). */
    val attempts: Int,
    /** Steps skipped on purpose, e.g. the Auth0 user when the Management API is not configured. */
    val warnings: List<String> = emptyList(),
    val lastError: String? = null,
    /** Conversation purges the job enqueued, and how many are DONE. */
    val conversationPurges: Int = 0,
    val conversationPurgesDone: Int = 0,
    /** True when this request created the job (false: it already existed). */
    val created: Boolean? = null,
    val createdAt: String? = null,
    val completedAt: String? = null
)

@Serializable
data class ClaimBackfillRequest(
    /** nextPageToken of the previous call; omit to start from the beginning. */
    val pageToken: String? = null,
    /** Message rows to scan in this call (1-1000, default 200). */
    val maxItems: Int? = null
)

@Serializable
data class ClaimBackfillResponse(
    val scannedMessages: Int,
    val messagesWithFiles: Int,
    /** Messages whose every linked object is now tagged kept. */
    val claimedMessages: Int,
    /** Messages whose claim failed; marked claimPending for the reconciler. */
    val pendingMessages: Int,
    /** Objects another conversation already kept, copied for this one. */
    val copiedObjects: Int,
    /** Rows deleted between the scan and the claim. */
    val vanishedMessages: Int,
    /** Pass back to continue; null when the whole table has been scanned. */
    val nextPageToken: String?,
    val done: Boolean
)
