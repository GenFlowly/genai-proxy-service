package com.genflowly.service

import com.genflowly.models.api.ClaimBackfillResponse
import com.genflowly.repository.ConversationRepository
import kotlinx.coroutines.delay
import org.slf4j.LoggerFactory

/**
 * The one-time kept-object backfill (1.13): claims the keys of every message
 * row written before the claim (1.16) went live, so the `pending` lifecycle
 * rule can be enabled without expiring linked objects.
 *
 * It pages through the whole Message table with a projection scan, one page
 * per call: the caller passes back [ClaimBackfillResponse.nextPageToken] until
 * it is null. Re-running is harmless (a key already kept for its conversation
 * is not touched), so a crashed or interrupted run resumes from its last
 * token. A message whose claim fails is marked claimPending and left to the
 * reconciler. Rate-limited to [maxMessagesPerSecond] messages that have files.
 */
class ClaimBackfillService(
    private val conversationRepository: ConversationRepository,
    private val objectClaimService: ObjectClaimService,
    private val maxMessagesPerSecond: Int = DEFAULT_MAX_MESSAGES_PER_SECOND,
    private val pause: suspend (Long) -> Unit = { delay(it) }
) {
    private val logger = LoggerFactory.getLogger(ClaimBackfillService::class.java)

    /** Processes one page of at most [maxItems] rows from [pageToken] (null = the start). */
    suspend fun runPage(pageToken: String?, maxItems: Int): ClaimBackfillResponse {
        val limit = maxItems.coerceIn(1, MAX_ITEMS_PER_CALL)
        val page = conversationRepository.scanMessageFileRefs(pageToken, limit)
        val minIntervalMs = 1000L / maxMessagesPerSecond.coerceAtLeast(1)

        var withFiles = 0
        var claimed = 0
        var pending = 0
        var copies = 0
        var vanished = 0
        for (message in page.items) {
            if (!objectClaimService.hasClaimableKeys(message.attachments, message.toolResultsJson)) continue
            withFiles++
            val started = System.nanoTime()
            val outcome = objectClaimService.claim(
                message.conversationId, message.messageId, message.role, message.attachments, message.toolResultsJson
            )
            copies += outcome.copies.size
            val attachmentsChanged = outcome.attachments != message.attachments
            val toolResultsChanged = outcome.toolResultsJson != message.toolResultsJson
            val flag = when {
                !outcome.complete -> true
                message.claimPending -> false
                else -> null
            }
            if (attachmentsChanged || toolResultsChanged || flag != null) {
                val stored = conversationRepository.updateMessageRetention(
                    conversationId = message.conversationId,
                    messageId = message.messageId,
                    attachments = outcome.attachments.takeIf { attachmentsChanged },
                    toolResultsJson = outcome.toolResultsJson.takeIf { toolResultsChanged },
                    claimPending = flag
                )
                if (!stored) {
                    // Deleted since the scan read it: nothing links what was just claimed
                    vanished++
                    objectClaimService.releaseToPending(outcome.newlyClaimed)
                    continue
                }
            }
            if (outcome.complete) claimed++ else pending++
            val elapsedMs = (System.nanoTime() - started) / 1_000_000
            if (elapsedMs < minIntervalMs) pause(minIntervalMs - elapsedMs)
        }
        logger.info(
            "Kept-object backfill page: {} row(s), {} with files, {} claimed, {} pending, {} copied, done={}",
            page.items.size, withFiles, claimed, pending, copies, page.nextPageToken == null
        )
        return ClaimBackfillResponse(
            scannedMessages = page.items.size,
            messagesWithFiles = withFiles,
            claimedMessages = claimed,
            pendingMessages = pending,
            copiedObjects = copies,
            vanishedMessages = vanished,
            nextPageToken = page.nextPageToken,
            done = page.nextPageToken == null
        )
    }

    companion object {
        const val DEFAULT_MAX_ITEMS = 200
        const val MAX_ITEMS_PER_CALL = 1000
        const val DEFAULT_MAX_MESSAGES_PER_SECOND = 20
    }
}
