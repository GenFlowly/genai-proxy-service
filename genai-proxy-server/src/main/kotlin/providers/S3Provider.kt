package com.genflowly.providers

import com.genflowly.models.AttachmentObjectInfo
import java.time.Duration
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import mu.KLogger
import software.amazon.awssdk.services.s3.S3Client
import software.amazon.awssdk.services.s3.model.GetObjectRequest
import software.amazon.awssdk.services.s3.model.HeadObjectRequest
import software.amazon.awssdk.services.s3.model.HeadObjectResponse
import software.amazon.awssdk.services.s3.model.NoSuchKeyException
import software.amazon.awssdk.services.s3.model.PutObjectRequest
import software.amazon.awssdk.services.s3.presigner.S3Presigner
import software.amazon.awssdk.services.s3.presigner.model.GetObjectPresignRequest
import software.amazon.awssdk.services.s3.presigner.model.PutObjectPresignRequest

class S3Provider(
    private val s3Client: S3Client,
    private val s3Presigner: S3Presigner,
    private val logger: KLogger,
    private val bucket: String
) {

    /** Presigned URL the browser PUTs the image bytes to. Content type is part of the signature. */
    suspend fun presignPut(
        key: String,
        mediaType: String,
        expiry: Duration = Duration.ofMinutes(15)
    ): String = withContext(Dispatchers.IO) {
        requireBucket()
        val objectRequest = PutObjectRequest.builder()
            .bucket(bucket)
            .key(key)
            .contentType(mediaType)
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

    private fun requireBucket() {
        check(bucket.isNotBlank()) { "ATTACHMENTS_BUCKET environment variable is not set" }
    }
}
