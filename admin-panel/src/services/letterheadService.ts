import { endpoints } from '../config/endpoints'

interface LetterheadLogoUpload {
    attachmentId: string
    uploadUrl: string
    mediaType: string
    requiredHeaders?: Record<string, string>
}

async function errorFrom(response: Response, action: string): Promise<Error> {
    if (response.status === 403) {
        return new Error('Admin access required — your account is not on the admin allowlist.')
    }
    const reason = await response
        .json()
        .then((body) => body?.error as string | undefined)
        .catch(() => undefined)
    return new Error(reason ?? `${action} failed: ${response.status} ${response.statusText}`)
}

/**
 * Uploads a letterhead logo (PNG or JPEG, at most 2 MB) for System agents and
 * returns its attachment id. The proxy presigns the upload under the System
 * owner's attachments, the only place generate_pdf reads a System agent's
 * logo from.
 */
export async function uploadLetterheadLogo(token: string, file: File): Promise<string> {
    const response = await fetch(endpoints.letterheadLogo, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ mediaType: file.type, sizeBytes: file.size, fileName: file.name }),
    })
    if (!response.ok) throw await errorFrom(response, 'Preparing the logo upload')
    const upload: LetterheadLogoUpload = await response.json()

    const put = await fetch(upload.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': upload.mediaType, ...(upload.requiredHeaders ?? {}) },
        body: file,
    })
    if (!put.ok) throw new Error(`Uploading the logo failed: ${put.status} ${put.statusText}`)
    return upload.attachmentId
}

/** A short-lived URL to preview a System letterhead logo, or null if it is gone. */
export async function getLetterheadLogoUrl(token: string, attachmentId: string): Promise<string | null> {
    const response = await fetch(endpoints.letterheadLogoUrl(attachmentId), {
        headers: { Authorization: `Bearer ${token}` },
    })
    if (response.status === 404) return null
    if (!response.ok) throw await errorFrom(response, 'Loading the logo')
    const body: { url: string } = await response.json()
    return body.url
}
