import { endpoints } from '../config/endpoints'
import { HttpMethod } from '../constants/http'
import { fetchWithRetry } from '../utils/apiUtils'

export type ReportedEntityType = 'CONVERSATION' | 'INSTRUCTION'

export const REPORT_REASONS = ['SPAM', 'HARASSMENT', 'HATE', 'SEXUAL', 'VIOLENCE', 'ILLEGAL', 'OTHER'] as const
export type ReportReason = typeof REPORT_REASONS[number]

/** The API refuses longer details. */
export const REPORT_DETAILS_MAX_CHARS = 1000

export interface SharedItemOwner {
    ownerCustomerId: string
    ownerUsername?: string | null
    ownerName?: string | null
    canBlock: boolean
    canRemove: boolean
    alreadyReported: boolean
}

export interface BlockedUser {
    customerId: string
    username?: string | null
    name?: string | null
    blockedAt: string
}

export type ModerationRefusal = 'CONTENT_BLOCKED' | 'BLOCKED'

/** The server refused to let content reach someone else. Its message is safe to show as is. */
export class ModerationError extends Error {
    constructor(message: string, readonly code: ModerationRefusal) {
        super(message)
        this.name = 'ModerationError'
    }
}

/** The error for a failed share or save: a [ModerationError] when the content rules refused it. */
export async function moderationErrorFrom(response: Response, action: string): Promise<Error> {
    let body: { error?: string; code?: string } | null = null
    try {
        body = await response.json()
    } catch {
        // No JSON body: an ordinary failure.
    }
    if (body?.code === 'CONTENT_BLOCKED' || body?.code === 'BLOCKED') {
        return new ModerationError(body.error ?? action, body.code)
    }
    return new Error(`${action}: ${response.status} ${response.statusText}`)
}

function authHeaders(token: string): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
}

export async function getSharedItemOwner(
    token: string,
    entityType: ReportedEntityType,
    entityId: string
): Promise<SharedItemOwner> {
    const query = new URLSearchParams({ entityType, entityId }).toString()
    const response = await fetchWithRetry(`${endpoints.sharedItemOwner}?${query}`, { headers: authHeaders(token) })
    if (!response.ok) throw new Error(`Get shared item owner failed: ${response.status} ${response.statusText}`)
    return response.json()
}

export async function reportContent(
    token: string,
    report: { entityType: ReportedEntityType; entityId: string; reason: ReportReason; details?: string }
): Promise<void> {
    const response = await fetchWithRetry(endpoints.reports, {
        method: HttpMethod.POST,
        headers: authHeaders(token),
        body: JSON.stringify(report),
    })
    if (!response.ok) throw new Error(`Report failed: ${response.status} ${response.statusText}`)
}

export async function getBlockedUsers(token: string): Promise<BlockedUser[]> {
    const response = await fetchWithRetry(endpoints.blocks, { headers: authHeaders(token) })
    if (!response.ok) throw new Error(`Get blocked users failed: ${response.status} ${response.statusText}`)
    return response.json()
}

export async function blockUser(token: string, customerId: string): Promise<void> {
    const response = await fetchWithRetry(endpoints.blocks, {
        method: HttpMethod.POST,
        headers: authHeaders(token),
        body: JSON.stringify({ customerId }),
    })
    if (!response.ok) throw new Error(`Block failed: ${response.status} ${response.statusText}`)
}

export async function unblockUser(token: string, customerId: string): Promise<void> {
    const response = await fetchWithRetry(`${endpoints.blocks}/${encodeURIComponent(customerId)}`, {
        method: HttpMethod.DELETE,
        headers: authHeaders(token),
    })
    if (!response.ok) throw new Error(`Unblock failed: ${response.status} ${response.statusText}`)
}
