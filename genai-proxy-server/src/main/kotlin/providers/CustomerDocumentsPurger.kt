package com.genflowly.providers

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import mu.KLogger
import software.amazon.awssdk.services.s3.S3Client
import software.amazon.awssdk.services.s3.model.Delete
import software.amazon.awssdk.services.s3.model.DeleteObjectsRequest
import software.amazon.awssdk.services.s3.model.ListObjectVersionsRequest
import software.amazon.awssdk.services.s3.model.ObjectIdentifier

/**
 * Deletes a customer's objects from the encoding-server's versioned
 * customer-documents bucket ({customerId}/notes/..., {customerId}/emails/...)
 * - every version and every delete marker, so nothing stays restorable
 * (plan 3.9). Needs s3:ListBucketVersions and s3:DeleteObjectVersion on that
 * bucket, which the proxy's IAM user is granted by name.
 */
class CustomerDocumentsPurger(
    private val s3Client: S3Client,
    private val bucket: String,
    private val logger: KLogger
) {
    /** Number of versions and delete markers removed. Idempotent; throws when some keep failing. */
    suspend fun purgeCustomer(customerId: String): Int {
        require(CUSTOMER_ID.matches(customerId)) { "Refusing a malformed customer id" }
        val prefix = "$customerId/"
        val versions = listVersions(prefix)
        if (versions.isEmpty()) return 0
        val failed = mutableListOf<ObjectIdentifier>()
        for (batch in versions.chunked(BATCH_SIZE)) {
            var pending = batch
            var attempt = 1
            while (pending.isNotEmpty()) {
                pending = deleteBatch(pending)
                if (pending.isEmpty()) break
                if (attempt >= MAX_ATTEMPTS) {
                    failed += pending
                    break
                }
                delay(RETRY_BASE_DELAY_MS shl (attempt - 1))
                attempt++
            }
        }
        check(failed.isEmpty()) { "${failed.size} customer-document version(s) could not be deleted" }
        logger.info { "Deleted ${versions.size} customer-document version(s) of customer $customerId" }
        return versions.size
    }

    private suspend fun listVersions(prefix: String): List<ObjectIdentifier> = withContext(Dispatchers.IO) {
        val out = mutableListOf<ObjectIdentifier>()
        var keyMarker: String? = null
        var versionMarker: String? = null
        do {
            val response = s3Client.listObjectVersions(
                ListObjectVersionsRequest.builder()
                    .bucket(bucket)
                    .prefix(prefix)
                    .apply {
                        keyMarker?.let { keyMarker(it) }
                        versionMarker?.let { versionIdMarker(it) }
                    }
                    .build()
            )
            response.versions().mapTo(out) { ObjectIdentifier.builder().key(it.key()).versionId(it.versionId()).build() }
            response.deleteMarkers().mapTo(out) { ObjectIdentifier.builder().key(it.key()).versionId(it.versionId()).build() }
            val more = response.isTruncated == true
            keyMarker = response.nextKeyMarker().takeIf { more }
            versionMarker = response.nextVersionIdMarker().takeIf { more }
        } while (keyMarker != null)
        out
    }

    /** One quiet DeleteObjects call; returns the identifiers S3 reported an Error for. */
    private suspend fun deleteBatch(ids: List<ObjectIdentifier>): List<ObjectIdentifier> = withContext(Dispatchers.IO) {
        val response = s3Client.deleteObjects(
            DeleteObjectsRequest.builder()
                .bucket(bucket)
                .delete(Delete.builder().objects(ids).quiet(true).build())
                .build()
        )
        if (!response.hasErrors() || response.errors().isEmpty()) return@withContext emptyList()
        val failed = response.errors().map { it.key() to it.versionId() }.toSet()
        ids.filter { (it.key() to it.versionId()) in failed }
    }

    companion object {
        const val BATCH_SIZE = 1_000
        const val MAX_ATTEMPTS = 5
        const val RETRY_BASE_DELAY_MS = 200L
        private val CUSTOMER_ID = Regex("^[A-Za-z0-9-]{1,64}$")
    }
}
