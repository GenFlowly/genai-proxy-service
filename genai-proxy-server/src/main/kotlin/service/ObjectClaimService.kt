package com.genflowly.service

import com.genflowly.models.AttachmentRef
import com.genflowly.observability.Metrics
import com.genflowly.providers.S3Provider
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import org.slf4j.LoggerFactory
import software.amazon.awssdk.services.s3.model.NoSuchKeyException

/**
 * The 1.16 kept-object claim: every S3 object a stored message links to is
 * tagged `retention=kept, conv=<conversationId>`, so the `retention=pending`
 * lifecycle rule never expires it, and a purge can find it from the row.
 *
 * - Keys come only from the message (attachments' s3Key and sourceKey, the
 *   legacy `<s3Key>.source.md` of an older generated file when it exists,
 *   and toolResultsJson image keys); each must match
 *   [RetentionKeys.RETENTION_KEY_PATTERN], and a malformed one is skipped
 *   and logged by attachment id only.
 * - A key already kept by ANOTHER conversation is not re-tagged (that would
 *   take it away from the other conversation): it is copied to
 *   customers/{owner of the original}/attachments/{uuid} - with its source
 *   sidecar, as `<copy>.source.md` - tagged for this conversation, and the
 *   ref is rewritten to the copy. The copy's uuid is derived from (message,
 *   original key), so a retry or a later reconciler pass reuses it.
 * - Each unit (an attachment with its sidecar, or a tool-result image) is
 *   tried [maxAttempts] times; units run in parallel, at most
 *   [maxConcurrency] at a time. A unit that still fails leaves the outcome
 *   incomplete: the caller then stores the message with claimPending and the
 *   reconciler retries.
 * - A missing object is not a failure: there is nothing to keep.
 */
class ObjectClaimService(
    private val s3Provider: S3Provider,
    private val maxConcurrency: Int = DEFAULT_MAX_CONCURRENCY,
    private val maxAttempts: Int = DEFAULT_MAX_ATTEMPTS,
    private val retryBaseDelayMs: Long = DEFAULT_RETRY_BASE_DELAY_MS
) {
    private val logger = LoggerFactory.getLogger(ObjectClaimService::class.java)

    /** What a claim did, and the message content that must be stored. */
    data class Outcome(
        /** The message's attachments, rewritten where a key was copied. */
        val attachments: List<AttachmentRef>,
        /** The message's toolResultsJson, rewritten where an image key was copied. */
        val toolResultsJson: String?,
        /**
         * Keys this claim moved to kept (they were not kept for this
         * conversation before), copies included: what to re-tag pending
         * when the message write fails.
         */
        val newlyClaimed: Set<String>,
        /** original key -> copy, for keys another conversation kept. */
        val copies: Map<String, String>,
        /** False when a unit could not be claimed: store with claimPending. */
        val complete: Boolean
    ) {
        companion object {
            fun unchanged(attachments: List<AttachmentRef>, toolResultsJson: String?) =
                Outcome(attachments, toolResultsJson, emptySet(), emptyMap(), complete = true)
        }
    }

    /** True when the message links to any object at all (a claim would do work). */
    fun hasClaimableKeys(attachments: List<AttachmentRef>, toolResultsJson: String?): Boolean =
        attachments.isNotEmpty() || RetentionKeys.toolResultImageKeys(toolResultsJson).isNotEmpty()

    suspend fun claim(
        conversationId: String,
        messageId: String,
        role: String?,
        attachments: List<AttachmentRef>,
        toolResultsJson: String?
    ): Outcome {
        if (!hasClaimableKeys(attachments, toolResultsJson)) return Outcome.unchanged(attachments, toolResultsJson)
        val semaphore = Semaphore(maxConcurrency)
        return coroutineScope {
            val attachmentResults = attachments.map { ref ->
                async { semaphore.withPermit { claimAttachment(conversationId, messageId, role, ref) } }
            }
            val imageKeys = RetentionKeys.toolResultImageKeys(toolResultsJson).distinct()
            val imageResults = imageKeys.map { key ->
                async { semaphore.withPermit { claimToolImage(conversationId, messageId, key) } }
            }
            val units = attachmentResults.awaitAll()
            val images = imageResults.awaitAll()

            val renamedImages = images.mapNotNull { r -> r.copyKey?.let { r.originalKey to it } }.toMap()
            val outcome = Outcome(
                attachments = units.map { it.ref },
                toolResultsJson = toolResultsJson?.let { RetentionKeys.rewriteToolResultImageKeys(it, renamedImages) },
                newlyClaimed = (units.flatMap { it.newlyClaimed } + images.flatMap { it.newlyClaimed }).toSet(),
                copies = units.flatMap { it.copies.entries }.associate { it.key to it.value } + renamedImages,
                complete = units.all { it.complete } && images.all { it.complete }
            )
            Metrics.count("retention_claim_total", 1.0, "status" to if (outcome.complete) "ok" else "pending")
            if (outcome.copies.isNotEmpty()) {
                Metrics.count("retention_claim_copies_total", outcome.copies.size.toDouble())
            }
            outcome
        }
    }

    /**
     * Re-tags [keys] `retention=pending` (the lifecycle rule then expires
     * them). Best effort: a missing key is skipped, failures are logged and
     * counted. Returns the number of keys that could not be re-tagged.
     */
    suspend fun releaseToPending(keys: Collection<String>): Int {
        val valid = keys.filter { RetentionKeys.isRetentionKey(it) }.distinct()
        if (valid.isEmpty()) return 0
        val semaphore = Semaphore(maxConcurrency)
        val failures = coroutineScope {
            valid.map { key ->
                async {
                    semaphore.withPermit {
                        try {
                            withRetries { s3Provider.putObjectTagging(key, PENDING_TAGS) }
                            0
                        } catch (e: NoSuchKeyException) {
                            0
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            logger.warn("Could not re-tag a released object pending: {}", e.javaClass.simpleName)
                            1
                        }
                    }
                }
            }.awaitAll().sum()
        }
        if (failures > 0) Metrics.count("retention_release_failure_total", failures.toDouble())
        return failures
    }

    // ── units ────────────────────────────────────────────────────────────────

    private data class AttachmentResult(
        val ref: AttachmentRef,
        val newlyClaimed: List<String>,
        val copies: Map<String, String>,
        val complete: Boolean
    )

    private data class ImageResult(
        val originalKey: String,
        val copyKey: String?,
        val newlyClaimed: List<String>,
        val complete: Boolean
    )

    private enum class TagState { MISSING, KEPT_HERE, KEPT_ELSEWHERE, CLAIMABLE }

    private suspend fun claimAttachment(
        conversationId: String,
        messageId: String,
        role: String?,
        ref: AttachmentRef
    ): AttachmentResult {
        if (!RetentionKeys.isRetentionKey(ref.s3Key)) {
            logger.warn("Skipping malformed attachment key on claim: attachmentId={}", ref.attachmentId)
            Metrics.count("retention_malformed_key_total", 1.0, "operation" to "claim")
            return AttachmentResult(ref, emptyList(), emptyMap(), complete = true)
        }
        val explicitSource = ref.sourceKey
        if (explicitSource != null && !RetentionKeys.isRetentionKey(explicitSource)) {
            logger.warn("Skipping malformed source key on claim: attachmentId={}", ref.attachmentId)
            Metrics.count("retention_malformed_key_total", 1.0, "operation" to "claim")
        }
        val source = explicitSource?.takeIf { RetentionKeys.isRetentionKey(it) }
        // A generated file stored before sourceKey existed may still have its sidecar next to it
        val legacySource = if (source == null && explicitSource == null && role == "assistant") {
            RetentionKeys.legacySourceKey(ref.s3Key)
        } else null
        val copyKey = copyKeyFor(messageId, ref.s3Key)
        val sidecar = source ?: legacySource

        return try {
            withRetries {
                val claimed = mutableListOf<String>()
                when (val state = tagState(ref.s3Key, conversationId)) {
                    TagState.MISSING -> {
                        logger.warn("Claimed object is missing: attachmentId={}", ref.attachmentId)
                        Metrics.count("retention_claim_missing_total")
                        AttachmentResult(ref, emptyList(), emptyMap(), complete = true)
                    }
                    TagState.KEPT_ELSEWHERE -> {
                        // Keep the other conversation's object as it is; this message gets its own copy
                        s3Provider.copyObject(ref.s3Key, copyKey, keptTags(conversationId))
                        claimed += copyKey
                        val copies = mutableMapOf(ref.s3Key to copyKey)
                        var newSource: String? = null
                        if (sidecar != null) {
                            val sidecarCopy = RetentionKeys.legacySourceKey(copyKey)
                            try {
                                s3Provider.copyObject(sidecar, sidecarCopy, keptTags(conversationId))
                                claimed += sidecarCopy
                                copies[sidecar] = sidecarCopy
                                newSource = sidecarCopy
                            } catch (e: NoSuchKeyException) {
                                if (source != null) logger.warn("Source sidecar is missing: attachmentId={}", ref.attachmentId)
                            }
                        }
                        logger.info(
                            "Attachment {} is kept by another conversation; claimed a copy for conversation {}",
                            ref.attachmentId, conversationId
                        )
                        // The copy has its sidecar next to it (or none); a malformed sourceKey stays as it was
                        val keptSourceKey = newSource ?: explicitSource?.takeIf { source == null }
                        AttachmentResult(ref.copy(s3Key = copyKey, sourceKey = keptSourceKey), claimed, copies, complete = true)
                    }
                    TagState.KEPT_HERE, TagState.CLAIMABLE -> {
                        if (claimIfNeeded(ref.s3Key, state, conversationId)) claimed += ref.s3Key
                        var newRef = ref
                        val copies = mutableMapOf<String, String>()
                        if (sidecar != null) {
                            when (val sidecarState = tagState(sidecar, conversationId)) {
                                TagState.MISSING ->
                                    if (source != null) logger.warn("Source sidecar is missing: attachmentId={}", ref.attachmentId)
                                TagState.KEPT_ELSEWHERE -> {
                                    // Rare: only the sidecar is another conversation's. Give this ref its own.
                                    val sidecarCopy = RetentionKeys.legacySourceKey(copyKey)
                                    s3Provider.copyObject(sidecar, sidecarCopy, keptTags(conversationId))
                                    claimed += sidecarCopy
                                    copies[sidecar] = sidecarCopy
                                    newRef = ref.copy(sourceKey = sidecarCopy)
                                }
                                TagState.KEPT_HERE, TagState.CLAIMABLE ->
                                    if (claimIfNeeded(sidecar, sidecarState, conversationId)) claimed += sidecar
                            }
                        }
                        AttachmentResult(newRef, claimed, copies, complete = true)
                    }
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: NoSuchKeyException) {
            // The object vanished between the tag read and the write: nothing to keep
            logger.warn("Claimed object disappeared: attachmentId={}", ref.attachmentId)
            Metrics.count("retention_claim_missing_total")
            AttachmentResult(ref, emptyList(), emptyMap(), complete = true)
        } catch (e: Exception) {
            logger.warn(
                "Kept-object claim failed after {} attempt(s): attachmentId={} error={}",
                maxAttempts, ref.attachmentId, e.javaClass.simpleName
            )
            AttachmentResult(ref, emptyList(), emptyMap(), complete = false)
        }
    }

    private suspend fun claimToolImage(conversationId: String, messageId: String, key: String): ImageResult {
        val label = RetentionKeys.attachmentIdOfKey(key) ?: "tool-result-image"
        if (!RetentionKeys.isRetentionKey(key)) {
            logger.warn("Skipping malformed tool-result image key on claim: attachmentId={}", label)
            Metrics.count("retention_malformed_key_total", 1.0, "operation" to "claim")
            return ImageResult(key, null, emptyList(), complete = true)
        }
        return try {
            withRetries {
                when (val state = tagState(key, conversationId)) {
                    TagState.MISSING -> ImageResult(key, null, emptyList(), complete = true)
                    TagState.KEPT_ELSEWHERE -> {
                        val copyKey = copyKeyFor(messageId, key)
                        s3Provider.copyObject(key, copyKey, keptTags(conversationId))
                        ImageResult(key, copyKey, listOf(copyKey), complete = true)
                    }
                    TagState.KEPT_HERE, TagState.CLAIMABLE -> {
                        val claimed = if (claimIfNeeded(key, state, conversationId)) listOf(key) else emptyList()
                        ImageResult(key, null, claimed, complete = true)
                    }
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: NoSuchKeyException) {
            ImageResult(key, null, emptyList(), complete = true)
        } catch (e: Exception) {
            logger.warn(
                "Kept-object claim failed after {} attempt(s): attachmentId={} error={}",
                maxAttempts, label, e.javaClass.simpleName
            )
            ImageResult(key, null, emptyList(), complete = false)
        }
    }

    // ── S3 helpers ───────────────────────────────────────────────────────────

    private suspend fun tagState(key: String, conversationId: String): TagState {
        val tags = try {
            s3Provider.getObjectTagging(key)
        } catch (e: NoSuchKeyException) {
            return TagState.MISSING
        }
        if (tags[RetentionKeys.RETENTION_TAG] != RetentionKeys.RETENTION_KEPT) return TagState.CLAIMABLE
        val conv = tags[RetentionKeys.CONVERSATION_TAG]
        return when {
            conv == conversationId -> TagState.KEPT_HERE
            conv.isNullOrBlank() -> TagState.CLAIMABLE
            else -> TagState.KEPT_ELSEWHERE
        }
    }

    /** Tags [key] kept for [conversationId] unless [state] says it already is; true when it changed. */
    private suspend fun claimIfNeeded(key: String, state: TagState, conversationId: String): Boolean {
        if (state == TagState.KEPT_HERE) return false
        s3Provider.putObjectTagging(key, keptTags(conversationId))
        return true
    }

    /**
     * The copy destination for [originalKey] claimed by [messageId]: under the
     * original owner's prefix, with a uuid derived from both so every retry
     * of the same claim writes the same key.
     */
    private fun copyKeyFor(messageId: String, originalKey: String): String {
        val owner = RetentionKeys.customerIdOfKey(originalKey)
            ?: throw IllegalArgumentException("Key has no customer segment")
        val uuid = UUID.nameUUIDFromBytes("$messageId\u0000$originalKey".toByteArray())
        return "customers/$owner/attachments/$uuid"
    }

    private suspend fun <T> withRetries(block: suspend () -> T): T {
        var attempt = 1
        while (true) {
            try {
                return block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: NoSuchKeyException) {
                throw e
            } catch (e: Exception) {
                if (attempt >= maxAttempts) throw e
                delay(retryBaseDelayMs shl (attempt - 1))
                attempt++
            }
        }
    }

    companion object {
        const val DEFAULT_MAX_CONCURRENCY = 8
        /** The first try plus 3 retries. */
        const val DEFAULT_MAX_ATTEMPTS = 4
        const val DEFAULT_RETRY_BASE_DELAY_MS = 100L

        fun keptTags(conversationId: String): Map<String, String> = mapOf(
            RetentionKeys.RETENTION_TAG to RetentionKeys.RETENTION_KEPT,
            RetentionKeys.CONVERSATION_TAG to conversationId
        )

        val PENDING_TAGS: Map<String, String> = mapOf(RetentionKeys.RETENTION_TAG to RetentionKeys.RETENTION_PENDING)
    }
}
