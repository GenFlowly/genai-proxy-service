package com.genflowly.providers

import com.genflowly.models.AttachmentObjectInfo
import java.time.Duration
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import mu.KLogger
import software.amazon.awssdk.services.s3.S3Client
import software.amazon.awssdk.services.s3.model.CopyObjectRequest
import software.amazon.awssdk.services.s3.model.Delete
import software.amazon.awssdk.services.s3.model.DeleteObjectsRequest
import software.amazon.awssdk.services.s3.model.GetObjectRequest
import software.amazon.awssdk.services.s3.model.GetObjectTaggingRequest
import software.amazon.awssdk.services.s3.model.HeadObjectRequest
import software.amazon.awssdk.services.s3.model.HeadObjectResponse
import software.amazon.awssdk.services.s3.model.ListObjectsV2Request
import software.amazon.awssdk.services.s3.model.NoSuchKeyException
import software.amazon.awssdk.services.s3.model.ObjectIdentifier
import software.amazon.awssdk.services.s3.model.PutObjectRequest
import software.amazon.awssdk.services.s3.model.PutObjectTaggingRequest
import software.amazon.awssdk.services.s3.model.Tag
import software.amazon.awssdk.services.s3.model.Tagging
import software.amazon.awssdk.services.s3.model.TaggingDirective
import software.amazon.awssdk.services.s3.presigner.S3Presigner
import software.amazon.awssdk.services.s3.presigner.model.GetObjectPresignRequest
import software.amazon.awssdk.services.s3.presigner.model.PutObjectPresignRequest

class S3Provider(
    private val s3Client: S3Client,
    private val s3Presigner: S3Presigner,
    private val logger: KLogger,
    private val bucket: String
) {

    /**
     * Presigned URL the browser PUTs the bytes to. Content type is part of the
     * signature. When [tagging] is set (URL-encoded `key=value&...`, e.g.
     * `retention=pending`), it is signed as the `x-amz-tagging` header, so the
     * client must send that header with exactly this value or S3 rejects the
     * PUT. Without it the signature is unchanged.
     */
    suspend fun presignPut(
        key: String,
        mediaType: String,
        tagging: String? = null,
        expiry: Duration = Duration.ofMinutes(15)
    ): String = withContext(Dispatchers.IO) {
        requireBucket()
        val objectRequest = PutObjectRequest.builder()
            .bucket(bucket)
            .key(key)
            .contentType(mediaType)
            .apply { if (tagging != null) tagging(tagging) }
            .build()
        val presignRequest = PutObjectPresignRequest.builder()
            .signatureDuration(expiry)
            .putObjectRequest(objectRequest)
            .build()
        s3Presigner.presignPutObject(presignRequest).url().toString()
    }

    /** Presigned URL the browser GETs to render a stored attachment. */
    suspend fun presignGet(
        key: String,
        expiry: Duration = Duration.ofHours(1)
    ): String = withContext(Dispatchers.IO) {
        requireBucket()
        val objectRequest = GetObjectRequest.builder()
            .bucket(bucket)
            .key(key)
            .build()
        val presignRequest = GetObjectPresignRequest.builder()
            .signatureDuration(expiry)
            .getObjectRequest(objectRequest)
            .build()
        s3Presigner.presignGetObject(presignRequest).url().toString()
    }

    /** Object metadata, or null when the key does not exist. */
    suspend fun head(key: String): AttachmentObjectInfo? = withContext(Dispatchers.IO) {
        requireBucket()
        try {
            val response: HeadObjectResponse = s3Client.headObject(
                HeadObjectRequest.builder().bucket(bucket).key(key).build()
            )
            AttachmentObjectInfo(sizeBytes = response.contentLength(), contentType = response.contentType())
        } catch (e: NoSuchKeyException) {
            null
        } catch (e: Exception) {
            logger.error(e) { "Failed to head S3 object $key" }
            throw e
        }
    }

    /**
     * Replaces the object's whole tag set with [tags] (S3 keeps no tag that is
     * not in it). Throws on failure, including NoSuchKeyException.
     */
    suspend fun putObjectTagging(key: String, tags: Map<String, String>) = withContext(Dispatchers.IO) {
        requireBucket()
        s3Client.putObjectTagging(
            PutObjectTaggingRequest.builder()
                .bucket(bucket)
                .key(key)
                .tagging(tags.toTagging())
                .build()
        )
        Unit
    }

    /** The object's tags. Throws on failure, including NoSuchKeyException for a missing key. */
    suspend fun getObjectTagging(key: String): Map<String, String> = withContext(Dispatchers.IO) {
        requireBucket()
        s3Client.getObjectTagging(
            GetObjectTaggingRequest.builder().bucket(bucket).key(key).build()
        ).tagSet().associate { it.key() to it.value() }
    }

    /**
     * Server-side copy of [srcKey] to [dstKey] in the bucket, keeping the
     * source's content type and metadata. With [tagging] the copy gets exactly
     * those tags; with null it keeps the source's tags. Throws on failure.
     */
    suspend fun copyObject(
        srcKey: String,
        dstKey: String,
        tagging: Map<String, String>? = null
    ) = withContext(Dispatchers.IO) {
        requireBucket()
        s3Client.copyObject(
            CopyObjectRequest.builder()
                .sourceBucket(bucket)
                .sourceKey(srcKey)
                .destinationBucket(bucket)
                .destinationKey(dstKey)
                .apply {
                    if (tagging == null) {
                        taggingDirective(TaggingDirective.COPY)
                    } else {
                        taggingDirective(TaggingDirective.REPLACE)
                        tagging(tagging.toTagging())
                    }
                }
                .build()
        )
        Unit
    }

    /**
     * Deletes [keys] and returns the ones that still failed. Sends at most
     * [DELETE_BATCH_SIZE] keys per DeleteObjects call in quiet mode, so S3
     * reports only the per-key Errors; only those keys are retried, with
     * exponential backoff, for at most [DELETE_MAX_ATTEMPTS] attempts per
     * batch. Deleting a key that does not exist succeeds, so a re-run is
     * idempotent. A call that fails as a whole (after the SDK's own retries)
     * throws.
     */
    suspend fun deleteObjects(keys: Collection<String>): List<String> {
        if (keys.isEmpty()) return emptyList()
        requireBucket()
        val stillFailing = mutableListOf<String>()
        for (batch in keys.distinct().chunked(DELETE_BATCH_SIZE)) {
            var pending = batch
            var attempt = 1
            while (true) {
                val failed = withContext(Dispatchers.IO) { deleteBatch(pending) }
                if (failed.isEmpty()) break
                if (attempt >= DELETE_MAX_ATTEMPTS) {
                    logger.warn { "S3 DeleteObjects: ${failed.size} key(s) still failing after $attempt attempts" }
                    stillFailing += failed
                    break
                }
                // Outside Dispatchers.IO: the wait holds no thread
                delay(DELETE_RETRY_BASE_DELAY_MS shl (attempt - 1))
                attempt++
                pending = failed
            }
        }
        return stillFailing
    }

    /** One quiet DeleteObjects call; returns the requested keys S3 reported an Error for. */
    private fun deleteBatch(keys: List<String>): List<String> {
        val response = s3Client.deleteObjects(
            DeleteObjectsRequest.builder()
                .bucket(bucket)
                .delete(
                    Delete.builder()
                        .objects(keys.map { ObjectIdentifier.builder().key(it).build() })
                        .quiet(true)
                        .build()
                )
                .build()
        )
        if (!response.hasErrors() || response.errors().isEmpty()) return emptyList()
        logger.warn {
            "S3 DeleteObjects: ${response.errors().size} of ${keys.size} key(s) failed " +
                "(codes ${response.errors().mapNotNull { it.code() }.distinct()})"
        }
        val requested = keys.toSet()
        return response.errors().mapNotNull { it.key() }.filter { it in requested }.distinct()
    }

    /**
     * Every key under [prefix], following continuation tokens. End the prefix
     * with "/" to stay within one "directory": "customers/abc" also matches
     * "customers/abcd/...".
     */
    suspend fun listKeys(prefix: String): List<String> = withContext(Dispatchers.IO) {
        require(prefix.isNotBlank()) { "listKeys needs a non-blank prefix" }
        requireBucket()
        val keys = mutableListOf<String>()
        var continuationToken: String? = null
        do {
            val response = s3Client.listObjectsV2(
                ListObjectsV2Request.builder()
                    .bucket(bucket)
                    .prefix(prefix)
                    .apply { continuationToken?.let { continuationToken(it) } }
                    .build()
            )
            response.contents().mapTo(keys) { it.key() }
            continuationToken = response.nextContinuationToken().takeIf { response.isTruncated == true }
        } while (continuationToken != null)
        keys
    }

    private fun requireBucket() {
        check(bucket.isNotBlank()) { "ATTACHMENTS_BUCKET environment variable is not set" }
    }

    private fun Map<String, String>.toTagging(): Tagging =
        Tagging.builder()
            .tagSet(map { (k, v) -> Tag.builder().key(k).value(v).build() })
            .build()

    companion object {
        /** DeleteObjects accepts at most 1,000 keys per call. */
        const val DELETE_BATCH_SIZE = 1_000
        const val DELETE_MAX_ATTEMPTS = 5
        /** Wait before the second attempt; doubles before each later one (200, 400, 800, 1600 ms). */
        const val DELETE_RETRY_BASE_DELAY_MS = 200L
    }
}
