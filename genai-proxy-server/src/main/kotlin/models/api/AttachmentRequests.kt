package com.genflowly.models.api

import kotlinx.serialization.Serializable

@Serializable
data class CreateAttachmentUploadRequest(
    val fileName: String,
    /**
     * Declared type (e.g. the browser's File.type). Any value is accepted;
     * blank, missing or malformed ones are stored as application/octet-stream.
     */
    val mediaType: String? = null,
    /** Size in bytes; must be at least 1, no upper limit. */
    val sizeBytes: Long
)

@Serializable
data class CreateAttachmentUploadResponse(
    val attachmentId: String,
    val s3Key: String,
    /** Effective (normalized) media type — may differ from the declared one. */
    val mediaType: String,
    /** Presigned S3 URL; PUT the raw bytes here with Content-Type = the returned mediaType */
    val uploadUrl: String
)

@Serializable
data class GetAttachmentUrlResponse(
    val attachmentId: String,
    /** Presigned S3 GET URL for rendering the image */
    val url: String
)
