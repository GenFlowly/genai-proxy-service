import { HttpMethod } from '../constants/http'
import { endpoints } from '../config/endpoints'
import { fetchWithRetry } from '../utils/apiUtils'
import {
    AttachmentRef,
    CreateAttachmentUploadResponse,
    GetAttachmentUrlResponse,
} from '../models/attachment.models'

/**
 * Media type declared for files the browser cannot type. Browsers report
 * `file.type === ''` for formats they don't know (HEIC/HEIF from iPhones on
 * Chrome/Firefox/Windows, JPEG XL, camera formats, ...).
 */
export const UNKNOWN_ATTACHMENT_MEDIA_TYPE = 'application/octet-stream'

/**
 * Uploads an image for use as a message attachment:
 * 1. asks the proxy server for a presigned S3 PUT URL, declaring the file's
 *    media type (or application/octet-stream when the browser reports none)
 * 2. PUTs the file's bytes, unmodified, straight to S3 (no proxy hop)
 * Returns the AttachmentRef to include in the generate request.
 *
 * The ConversationWidget hands in images already converted to a PNG within
 * the backend's limits by the component library's prepareImageForUpload.
 *
 * No image-type or size restriction is applied here or by the proxy: the
 * proxy only normalizes the declared media type (blank, malformed, non-image
 * or SVG values become application/octet-stream) and returns that *effective*
 * type, which is bound
 * into the presigned PUT signature, so the PUT must use it rather than
 * `file.type`. The retrieval-server sniffs the real format from the bytes and
 * converts/compresses losslessly for the LLM vendors; the original object in
 * S3 is never modified.
 */
export async function uploadAttachment(token: string, file: File): Promise<AttachmentRef> {
    const presignResponse = await fetchWithRetry(endpoints.attachments, {
        method: HttpMethod.POST,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
            fileName: file.name || 'pasted-image',
            mediaType: file.type || UNKNOWN_ATTACHMENT_MEDIA_TYPE,
            sizeBytes: file.size,
        }),
    })

    if (!presignResponse.ok) {
        const body = await presignResponse.json().catch(() => null)
        throw new Error(body?.error || `Attachment presign failed: ${presignResponse.status}`)
    }

    const presign: CreateAttachmentUploadResponse = await presignResponse.json()

    const uploadResponse = await fetchWithRetry(presign.uploadUrl, {
        method: HttpMethod.PUT,
        headers: {
            // The server's effective (normalized) type — it is bound into the
            // presigned signature and may differ from file.type
            'Content-Type': presign.mediaType,
        },
        body: file,
    })

    if (!uploadResponse.ok) {
        throw new Error(`Attachment upload to S3 failed: ${uploadResponse.status}`)
    }

    return {
        attachmentId: presign.attachmentId,
        s3Key: presign.s3Key,
        mediaType: presign.mediaType,
        // Carry the display name so the backend can name the document to the
        // model (e.g. "[Attached PDF: report.pdf]") and in download cards.
        // Harmless for images (shown as a label only).
        filename: file.name || undefined,
    }
}

/** Presigned GET URL for rendering an attachment owned by the authenticated customer. */
export async function getAttachmentViewUrl(token: string, attachmentId: string): Promise<string> {
    const response = await fetchWithRetry(endpoints.attachmentUrl(attachmentId), {
        method: HttpMethod.GET,
        headers: {
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        throw new Error(`Get attachment URL failed: ${response.status}`)
    }

    const data: GetAttachmentUrlResponse = await response.json()
    return data.url
}
