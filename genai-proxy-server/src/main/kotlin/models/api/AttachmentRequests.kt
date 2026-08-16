package com.genflowly.models.api

import kotlinx.serialization.Serializable

@Serializable
data class CreateAttachmentUploadRequest(
    val fileName: String,
    val mediaType: String,
    val sizeBytes: Long
)

@Serializable
data class CreateAttachmentUploadResponse(
    val attachmentId: String,
    val s3Key: String,
    val mediaType: String,
    /** Presigned S3 URL; PUT the raw image bytes here with Content-Type = mediaType */
    val uploadUrl: String
)

@Serializable
data class GetAttachmentUrlResponse(
    val attachmentId: String,
    /** Presigned S3 GET URL for rendering the image */
    val url: String
)
