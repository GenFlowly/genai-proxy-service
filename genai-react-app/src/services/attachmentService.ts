import { HttpMethod } from '../constants/http'
import { endpoints } from '../config/endpoints'
import { fetchWithRetry } from '../utils/apiUtils'
import {
    AttachmentRef,
    CreateAttachmentUploadResponse,
    GetAttachmentUrlResponse,
} from '../models/attachment.models'

/**
 * Uploads an image for use as a message attachment:
 * 1. asks the proxy server for a presigned S3 PUT URL
 * 2. PUTs the raw file bytes straight to S3 (no proxy hop)
 * Returns the AttachmentRef to include in the generate request.
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
            mediaType: file.type,
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
            // Must match the content type bound into the presigned signature
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
