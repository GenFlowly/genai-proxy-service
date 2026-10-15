package com.genflowly.models.api

import kotlinx.serialization.Serializable

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
