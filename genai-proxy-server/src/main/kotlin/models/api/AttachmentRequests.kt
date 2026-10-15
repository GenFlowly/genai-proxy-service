package com.genflowly.models.api

import kotlinx.serialization.Serializable

@Serializable
data class CreateAttachmentUploadRequest(
    /** Original file name; returned (sanitized) as fileName for the client to send as AttachmentRef.filename. */
    val fileName: String,
    /**
     * Declared type (e.g. the browser's File.type). Any value is accepted;
     * blank, missing or malformed ones are stored as application/octet-stream.
     * application/pdf is kept, up to 10 MB.
     */
    val mediaType: String? = null,
    /** Size in bytes; must be at least 1. No upper limit for images; at most 10 MB for a PDF. */
    val sizeBytes: Long,
    /**
     * When true, the upload is tagged retention=pending: S3 expires it unless
     * a message links it. New clients always send true; PDFs are tagged
     * either way. The PUT must then carry every requiredHeaders entry.
     */
    val tagging: Boolean = false
)

@Serializable
data class CreateAttachmentUploadResponse(
    val attachmentId: String,
    val s3Key: String,
    /** Effective (normalized) media type — may differ from the declared one. */
    val mediaType: String,
    /** Presigned S3 URL; PUT the raw bytes here with Content-Type = the returned mediaType */
    val uploadUrl: String,
    /** Sanitized file name; send it back as the attachment's filename in the generate request. */
    val fileName: String? = null,
    /**
     * Headers signed into uploadUrl besides Content-Type (e.g. x-amz-tagging).
     * The PUT must send every entry with exactly this value or S3 rejects it.
     */
    val requiredHeaders: Map<String, String> = emptyMap()
)

@Serializable
data class GetAttachmentUrlResponse(
    val attachmentId: String,
    /** Presigned S3 GET URL for rendering the image */
    val url: String
)
