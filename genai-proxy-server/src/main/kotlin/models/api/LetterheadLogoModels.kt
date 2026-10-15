package com.genflowly.models.api

import kotlinx.serialization.Serializable

/** Admin request to upload a System agent's PDF letterhead logo (plan 6.2). */
@Serializable
data class LetterheadLogoUploadRequest(
    /** image/png or image/jpeg. */
    val mediaType: String? = null,
    /** At most 2 MB. */
    val sizeBytes: Long,
    /** Display only; the object key never contains it. */
    val fileName: String? = null
)

@Serializable
data class LetterheadLogoUploadResponse(
    /** Goes into tool_settings.generate_pdf.logo_attachment_id. */
    val attachmentId: String,
    /** Presigned S3 URL; PUT the raw bytes here with Content-Type = mediaType. */
    val uploadUrl: String,
    val mediaType: String,
    /** Headers signed into uploadUrl, to send with the PUT (none today). */
    val requiredHeaders: Map<String, String> = emptyMap()
)

@Serializable
data class LetterheadLogoUrlResponse(
    val attachmentId: String,
    /** Presigned S3 GET URL for previewing the logo. */
    val url: String
)
