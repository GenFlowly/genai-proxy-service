package com.genflowly.providers

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import software.amazon.awssdk.services.s3.S3Client
import software.amazon.awssdk.services.s3.model.Delete
import software.amazon.awssdk.services.s3.model.DeleteObjectsRequest
import software.amazon.awssdk.services.s3.model.ListObjectVersionsRequest
import software.amazon.awssdk.services.s3.model.ObjectIdentifier

/**
 * Hard-deletes a customer's batch-mode note documents from the encoding
 * service's customer-documents bucket. The bucket is versioned, so every
 * version and delete marker under "{customerId}/" goes, not just the current
 * objects. [bucket] is null when CUSTOMER_DOCUMENTS_BUCKET is unset.
 */
class CustomerDocumentsPurger(
    private val s3Client: S3Client,
    private val bucket: String?
) {
    val isConfigured: Boolean get() = !bucket.isNullOrBlank()

    /** Deletes every version under the customer's prefix; returns how many. Throws when S3 refuses any. */
    suspend fun purgeCustomer(customerId: String): Int = purgeVersions("$customerId/") { true }

    /**
     * Deletes every version of one note's document, "{customerId}/notes/{noteKey}.json";
     * returns how many. Only that exact key goes, whatever the note key holds.
     */
    suspend fun purgeNote(customerId: String, noteKey: String): Int {
        val key = "$customerId/notes/$noteKey.json"
        return purgeVersions(key) { it == key }
    }

    private suspend fun purgeVersions(prefix: String, keep: (String) -> Boolean): Int = withContext(Dispatchers.IO) {
        val bucket = bucket?.takeIf { it.isNotBlank() } ?: return@withContext 0
        val versions = s3Client.listObjectVersionsPaginator(
            ListObjectVersionsRequest.builder().bucket(bucket).prefix(prefix).build()
        ).flatMap { page ->
            page.versions().filter { keep(it.key()) }
                .map { ObjectIdentifier.builder().key(it.key()).versionId(it.versionId()).build() } +
                page.deleteMarkers().filter { keep(it.key()) }
                    .map { ObjectIdentifier.builder().key(it.key()).versionId(it.versionId()).build() }
        }
        val failed = versions.chunked(MAX_KEYS_PER_DELETE).sumOf { batch ->
            s3Client.deleteObjects(
                DeleteObjectsRequest.builder()
                    .bucket(bucket)
                    .delete(Delete.builder().objects(batch).quiet(true).build())
                    .build()
            ).errors().size
        }
        check(failed == 0) { "$failed customer document version(s) could not be deleted" }
        versions.size
    }

    private companion object {
        const val MAX_KEYS_PER_DELETE = 1000
    }
}
