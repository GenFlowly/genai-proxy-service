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
 * The presign response as the proxy sends it: the library's
 * CreateAttachmentUploadResponse plus the headers the PUT was signed with
 * (declared here until the installed component-library version has them).
 */
type PresignResponse = CreateAttachmentUploadResponse & {
    requiredHeaders?: Record<string, string>
}

/**
 * Uploads a file (an image, or a PDF where the composer accepts them) for
 * use as a message attachment:
 * 1. asks the proxy server for a presigned S3 PUT URL, declaring the file's
 *    name, size and media type (application/octet-stream when the browser
 *    reports none), and asking for the retention tag (`tagging`): an upload
 *    that no message ends up linking expires instead of staying forever
 * 2. PUTs the raw, unmodified file bytes straight to S3 (no proxy hop), with
 *    every header the presigned PUT was signed with (`requiredHeaders`, e.g.
 *    x-amz-tagging) — S3 rejects the signature without them
 * Returns the AttachmentRef to include in the generate request, with the
 * file's name and size for display.
 *
 * No type allowlist or size cap applies to images here or in the proxy: the
 * proxy only normalizes the declared media type (blank, malformed or
 * scriptable values become application/octet-stream; images and PDFs are
 * kept) and returns that *effective* type, which is bound into the presigned
 * PUT signature, so the PUT must use it rather than `file.type`. PDFs are
 * limited to 10 MB (checked by the composer and again at presign). The
 * retrieval-server sniffs the real format from the bytes; the original
 * object in S3 is never modified.
 */
export async function uploadAttachment(token: string, file: File): Promise<AttachmentRef> {
    const fileName = file.name || (file.type === 'application/pdf' ? 'document.pdf' : 'pasted-image')
    const presignResponse = await fetchWithRetry(endpoints.attachments, {
        method: HttpMethod.POST,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
            fileName,
            mediaType: file.type || UNKNOWN_ATTACHMENT_MEDIA_TYPE,
            sizeBytes: file.size,
            tagging: true,
        }),
    })

    if (!presignResponse.ok) {
        const body = await presignResponse.json().catch(() => null)
        throw new Error(body?.error || `Attachment presign failed: ${presignResponse.status}`)
    }

    const presign: PresignResponse = await presignResponse.json()

    const uploadResponse = await fetchWithRetry(presign.uploadUrl, {
        method: HttpMethod.PUT,
        headers: {
            // The server's effective (normalized) type — it is bound into the
            // presigned signature and may differ from file.type
            'Content-Type': presign.mediaType,
            // Every other signed header (e.g. x-amz-tagging: retention=pending)
            ...(presign.requiredHeaders ?? {}),
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
        filename: fileName,
        sizeBytes: file.size,
    }
}

/**
 * Presigned GET URL for viewing/downloading an attachment. With a
 * conversationId (any file shown inside a loaded conversation) the proxy
 * checks the caller's access to that conversation — owner, or a share role
 * including PUBLIC — and that the file belongs to it, so participants of a
 * shared conversation can open files another participant uploaded or
 * generated. Without one, only the caller's own attachments resolve.
 */
export async function getAttachmentViewUrl(
    token: string,
    attachmentId: string,
    conversationId?: string
): Promise<string> {
    const response = await fetchWithRetry(endpoints.attachmentUrl(attachmentId, conversationId || undefined), {
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
