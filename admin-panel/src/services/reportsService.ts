import { endpoints } from '../config/endpoints'

export type ReportStatus = 'OPEN' | 'RESOLVED'
export type ReportAction = 'DISMISS' | 'MAKE_PRIVATE' | 'RESOLVE'

export interface ContentReport {
    entityId: string
    entityType: 'CONVERSATION' | 'INSTRUCTION'
    messageId?: string | null
    title?: string | null
    ownerCustomerId?: string | null
    ownerUsername?: string | null
    reporterCustomerId: string
    reporterUsername?: string | null
    reason: 'SPAM' | 'HARASSMENT' | 'HATE' | 'SEXUAL' | 'VIOLENCE' | 'ILLEGAL' | 'OTHER'
    details?: string | null
    contentSnapshot: string
    status: ReportStatus
    createdAt: string
    resolvedAt?: string | null
    resolvedBy?: string | null
    resolution?: 'DISMISSED' | 'MADE_PRIVATE' | 'RESOLVED' | null
    resolutionNote?: string | null
}

export interface ListContentReportsResponse {
    reports: ContentReport[]
    nextCursor?: string | null
    openCount: number
}

async function assertOk(response: Response, action: string): Promise<void> {
    if (response.ok) return
    if (response.status === 403) {
        throw new Error('Admin access required — your account is not on the admin allowlist.')
    }
    const reason = await response
        .json()
        .then((body) => body?.error as string | undefined)
        .catch(() => undefined)
    throw new Error(reason ?? `${action} failed: ${response.status} ${response.statusText}`)
}

export async function listContentReports(
    token: string,
    status: ReportStatus,
    cursor: string | null,
    limit = 25
): Promise<ListContentReportsResponse> {
    const query = new URLSearchParams({ status, limit: String(limit), ...(cursor ? { cursor } : {}) })
    const response = await fetch(`${endpoints.adminReports}?${query}`, {
        headers: { Authorization: `Bearer ${token}` },
    })
    await assertOk(response, 'Loading reports')
    return response.json()
}

export async function resolveContentReport(
    token: string,
    report: ContentReport,
    action: ReportAction,
    note: string
): Promise<void> {
    const response = await fetch(endpoints.adminReport(report.entityId, report.reporterCustomerId), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...(note.trim() ? { note: note.trim() } : {}) }),
    })
    await assertOk(response, 'Updating the report')
}
